import { randomBytes, randomUUID } from 'node:crypto';
import { win32, posix } from 'node:path';
import { Store } from './store.js';
import { AppError, input, textField, type Result, type Status } from '../shared/contracts.js';

export interface Run { id:string;taskId:string;agentId:string;attempt:number;state:string;initiatedBy:string;startedAt:string;deadlineAt:string;endedAt:string|null;error:string|null }
export interface Runner {
  ready(): boolean;
  launch(context:{run:Run;token:string;task:ReturnType<Store['task']>;rejectionReason:string|null}, ended:(outcome:'succeeded'|'failed'|'cancelled'|'interrupted',error:string|null,terminated:boolean)=>void): void;
  cancel(runId:string): void;
}
export class DisabledRunner implements Runner {
  ready(){return false;}
  launch(){throw new Error('Windows isolation is not configured and verified');}
  cancel(){throw new AppError(503,'ISOLATION_REQUIRED','실행 프로세스 종료 확인 어댑터가 필요합니다.');}
}
export class Runs {
  private tokens=new Map<string,string>();
  private timers=new Map<string,ReturnType<typeof setTimeout>>();
  constructor(private store:Store,private runner:Runner,private emit:()=>void) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,attempt INTEGER NOT NULL,state TEXT NOT NULL CHECK(state IN ('launching','running','submitted','succeeded','failed','cancelled','interrupted')),
      initiated_by TEXT NOT NULL,started_at TEXT NOT NULL,deadline_at TEXT NOT NULL,ended_at TEXT,error TEXT,UNIQUE(task_id,attempt));
      CREATE UNIQUE INDEX IF NOT EXISTS one_agent_run ON runs(agent_id) WHERE state IN ('launching','running','submitted');
      CREATE TABLE IF NOT EXISTS results(id TEXT PRIMARY KEY,run_id TEXT NOT NULL UNIQUE REFERENCES runs(id) ON DELETE RESTRICT,summary TEXT NOT NULL,changed_files_json TEXT NOT NULL,tests_json TEXT NOT NULL,submitted_at TEXT NOT NULL);
      CREATE TRIGGER IF NOT EXISTS results_no_update BEFORE UPDATE ON results BEGIN SELECT RAISE(ABORT,'immutable result'); END;
      CREATE TRIGGER IF NOT EXISTS results_no_delete BEFORE DELETE ON results BEGIN SELECT RAISE(ABORT,'immutable result'); END;`);
    // Persisted active runs stay occupied until the OS adapter confirms tree termination.
    // All old capabilities are absent in this fresh process.
  }
  run(id:string):Run {
    const row=this.store.db.prepare('SELECT id,task_id AS taskId,agent_id AS agentId,attempt,state,initiated_by AS initiatedBy,started_at AS startedAt,deadline_at AS deadlineAt,ended_at AS endedAt,error FROM runs WHERE id=?').get(id);
    if(!row)throw new AppError(404,'NOT_FOUND','실행이 없습니다.');return row as unknown as Run;
  }
  list(taskId:string) {
    this.store.task(taskId);
    const ids=this.store.db.prepare('SELECT id FROM runs WHERE task_id=? ORDER BY attempt DESC').all(taskId);
    return ids.map(row=>({...this.run(String(row.id)),result:this.result(String(row.id))}));
  }
  result(runId:string):Result|null {
    const row=this.store.db.prepare('SELECT summary,changed_files_json,tests_json FROM results WHERE run_id=?').get(runId);
    return row?{summary:String(row.summary),changedFiles:JSON.parse(String(row.changed_files_json)),tests:JSON.parse(String(row.tests_json))}:null;
  }
  private active(agentId:string) {return this.store.db.prepare("SELECT id FROM runs WHERE agent_id=? AND state IN ('launching','running','submitted')").get(agentId);}
  private version(taskId:string,value:unknown) {
    const task=this.store.task(taskId);
    if(!Number.isSafeInteger(value)||Number(value)<1)throw new AppError(400,'INVALID_INPUT','expectedVersion이 필요합니다.');
    if(task.version!==value)throw new AppError(409,'VERSION_CONFLICT','작업이 변경되었습니다. 새로고침하세요.');return task;
  }
  private event(taskId:string,runId:string|null,event:string,actorType:'human'|'agent'|'server',actorId:string,name:string,to:Status,reason:string|null=null) {
    const task=this.store.task(taskId),time=new Date().toISOString();
    this.store.db.prepare('UPDATE tasks SET status=?,version=version+1,updated_at=? WHERE id=?').run(to,time,taskId);
    this.store.db.prepare('INSERT INTO task_events(task_id,run_id,event_type,actor_type,actor_id,actor_name_snapshot,from_status,to_status,reason,happened_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(taskId,runId,event,actorType,actorId,name,task.status,to,reason,time);
  }
  launch(taskId:string,value:unknown):Run {
    const data=input(value,['expectedVersion']);
    let run:Run;
    this.store.transaction(()=>{
      const task=this.version(taskId,data.expectedVersion);
      if(task.status!=='todo'||this.active(task.agentId))throw new AppError(409,'RUN_CONFLICT','작업 또는 담당 에이전트가 이미 실행 중입니다.');
      if(!this.runner.ready())throw new AppError(503,'ISOLATION_REQUIRED','Windows 격리·CLI 로그인 검증 후 실행할 수 있습니다.');
      const attempt=Number(this.store.db.prepare('SELECT COALESCE(MAX(attempt),0)+1 AS attempt FROM runs WHERE task_id=?').get(taskId)!.attempt),id=randomUUID(),time=new Date();
      this.store.db.prepare('INSERT INTO runs VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,taskId,task.agentId,attempt,'launching','owner',time.toISOString(),new Date(time.getTime()+30*60*1000).toISOString(),null,null);
      run=this.run(id);
      this.event(taskId,id,'run_requested','human','owner','소유자','todo');
    });
    const token=randomBytes(32).toString('hex');this.tokens.set(token,run!.id);
    this.timers.set(run!.id,setTimeout(()=>{this.revoke(run!.id);try{this.runner.cancel(run!.id);}catch{this.finish(run!.id,'failed','시간 초과 후 프로세스 종료 확인 실패',false);}},30*60*1000));
    const rejection=this.store.db.prepare("SELECT reason FROM task_events WHERE task_id=? AND event_type='rejected' ORDER BY id DESC LIMIT 1").get(taskId);
    this.emit();
    try {
      this.runner.launch({run:run!,token,task:this.store.task(taskId),rejectionReason:rejection?String(rejection.reason):null},(outcome,error,terminated)=>this.finish(run!.id,outcome,error,terminated));
    }catch{
      // Launch throw contract means no process was created.
      this.finish(run!.id,'failed','프로세스를 생성하지 못했습니다.',true);
    }
    return this.run(run!.id);
  }
  capability(token:string|undefined,id:string):Run {
    const bound=token?this.tokens.get(token):undefined;
    if(!bound)throw new AppError(401,'INVALID_CAPABILITY','실행 권한이 만료되었거나 없습니다.');
    if(bound!==id)throw new AppError(403,'FORBIDDEN','담당 실행만 접근할 수 있습니다.');
    const run=this.run(id);
    if(Date.now()>=Date.parse(run.deadlineAt)){this.revoke(id);throw new AppError(401,'INVALID_CAPABILITY','실행 권한이 만료되었습니다.');}
    return run;
  }
  assigned(token:string|undefined,id:string) {const run=this.capability(token,id);const reason=this.store.db.prepare("SELECT reason FROM task_events WHERE task_id=? AND event_type='rejected' ORDER BY id DESC LIMIT 1").get(run.taskId);return {task:this.store.task(run.taskId),rejectionReason:reason?String(reason.reason):null};}
  start(token:string|undefined,id:string,value:unknown) {
    input(value,[]);const run=this.capability(token,id);
    if(run.state==='running')return this.store.task(run.taskId);
    if(run.state!=='launching')throw new AppError(409,'RUN_CONFLICT','시작할 수 없는 실행입니다.');
    this.store.transaction(()=>{
      if(this.store.task(run.taskId).status!=='todo')throw new AppError(409,'STATE_CONFLICT','시작할 수 없는 작업입니다.');
      this.store.db.prepare("UPDATE runs SET state='running' WHERE id=?").run(id);
      this.event(run.taskId,id,'started','agent',run.agentId,this.store.agent(run.agentId).name,'in_progress');
    });this.emit();return this.store.task(run.taskId);
  }
  submit(token:string|undefined,id:string,value:unknown) {
    const run=this.capability(token,id),result=validateResult(value);
    if(run.state!=='running')throw new AppError(409,'RUN_CONFLICT','진행 중인 실행만 제출할 수 있습니다.');
    this.store.transaction(()=>{
      this.store.db.prepare('INSERT INTO results VALUES(?,?,?,?,?,?)').run(randomUUID(),id,result.summary,JSON.stringify(result.changedFiles),JSON.stringify(result.tests),new Date().toISOString());
      this.store.db.prepare("UPDATE runs SET state='submitted' WHERE id=?").run(id);
      this.event(run.taskId,id,'submitted','agent',run.agentId,this.store.agent(run.agentId).name,'review');
    });this.revoke(id);this.emit();return this.store.task(run.taskId);
  }
  private revoke(id:string) {for(const [token,runId]of this.tokens)if(runId===id)this.tokens.delete(token);}
  finish(id:string,outcome:'succeeded'|'failed'|'cancelled'|'interrupted',error:string|null,terminated:boolean) {
    const run=this.run(id);this.revoke(id);
    if(!['launching','running','submitted'].includes(run.state))return;
    if(!terminated){this.store.db.prepare('UPDATE runs SET error=? WHERE id=?').run('프로세스 트리 종료 미확인: 새 실행·판정 차단',id);this.emit();return;}
    const timer=this.timers.get(id);if(timer)clearTimeout(timer);this.timers.delete(id);
    const hasResult=!!this.result(id),state=!hasResult&&outcome==='succeeded'?'failed':outcome;
    this.store.transaction(()=>{
      this.store.db.prepare('UPDATE runs SET state=?,ended_at=?,error=? WHERE id=?').run(state,new Date().toISOString(),error??(!hasResult?'유효한 결과 없이 실행 종료':null),id);
      this.event(run.taskId,id,'run_'+state,'server','server','보드 서버',hasResult?'review':'todo',error??(!hasResult?'유효한 결과 없이 실행 종료':null));
    });this.emit();
  }
  cancel(id:string,value:unknown) {
    input(value,[]);const run=this.run(id);
    if(!['launching','running','submitted'].includes(run.state))throw new AppError(409,'RUN_CONFLICT','이미 종료된 실행입니다.');
    this.revoke(id);this.runner.cancel(id);return this.run(id);
  }
  judge(taskId:string,value:unknown,approve:boolean) {
    const data=input(value,approve?['expectedVersion']:['expectedVersion','reason']),reason=approve?null:textField(data.reason,'반려 이유',2000);
    this.store.transaction(()=>{
      const task=this.version(taskId,data.expectedVersion);
      if(task.status!=='review'||this.active(task.agentId))throw new AppError(409,'STATE_CONFLICT','실행 종료가 확인된 Review만 판정할 수 있습니다.');
      const latest=this.list(taskId)[0];
      if(!latest?.result)throw new AppError(409,'STATE_CONFLICT','제출 결과가 없습니다.');
      this.event(taskId,latest.id,approve?'approved':'rejected','human','owner','소유자',approve?'done':'todo',reason);
    });this.emit();return this.store.task(taskId);
  }
  close(){this.tokens.clear();for(const timer of this.timers.values())clearTimeout(timer);this.timers.clear();}
}
export function validateResult(value:unknown):Result {
  const data=input(value,['summary','changedFiles','tests']),summary=textField(data.summary,'작업 요약',10000);
  if(!Array.isArray(data.changedFiles)||data.changedFiles.length>500||!Array.isArray(data.tests)||!data.tests.length||data.tests.length>500)throw new AppError(400,'INVALID_RESULT','파일·테스트 결과 배열이 필요합니다. 미실행 테스트는 이유를 기록하세요.');
  const changedFiles=data.changedFiles.map(path=>{
    const p=textField(path,'변경 파일',1000);
    if(win32.isAbsolute(p)||posix.isAbsolute(p)||p.includes('\\')||p.includes(':')||p.split('/').some(s=>!s||s==='.'||s==='..'))throw new AppError(400,'INVALID_RESULT','작업 폴더 상대 경로만 허용합니다.');return p;
  });
  const tests=data.tests.map(value=>{const t=input(value,['name','status','details']),name=textField(t.name,'테스트 이름',200),details=textField(t.details,'테스트 상세',4000);
    if(!['passed','failed','not_run'].includes(String(t.status)))throw new AppError(400,'INVALID_RESULT','테스트 상태가 잘못되었습니다.');return {name,status:t.status as Result['tests'][number]['status'],details};});
  return {summary,changedFiles,tests};
}
