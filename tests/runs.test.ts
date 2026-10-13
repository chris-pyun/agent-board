import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { basename,dirname,join,resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../src/server/app.js';
import { Store } from '../src/server/store.js';
import { Runs,DisabledRunner,type Runner } from '../src/server/runs.js';
import { AppError } from '../src/shared/contracts.js';

class ControlledRunner implements Runner {
  contexts=new Map<string,Parameters<Runner['launch']>[0]>();
  endings=new Map<string,Parameters<Runner['launch']>[1]>();
  cancelled:string[]=[];
  ready(){return true;}
  launch(context:Parameters<Runner['launch']>[0],ended:Parameters<Runner['launch']>[1]) {this.contexts.set(context.run.id,context);this.endings.set(context.run.id,ended);}
  cancel(id:string){this.cancelled.push(id);}
  end(id:string,outcome:Parameters<Parameters<Runner['launch']>[1]>[0]='succeeded',error:string|null=null,terminated=true){this.endings.get(id)!(outcome,error,terminated);}
  token(id:string){return this.contexts.get(id)!.token;}
}
const result={summary:'작업 요약',changedFiles:[],tests:[{name:'테스트',status:'not_run',details:'더미 실행으로 테스트 미실행'}]};
function cleanup(root:string){const path=resolve(root);assert.equal(dirname(path).toLowerCase(),resolve(tmpdir()).toLowerCase());assert.match(basename(path),/^kanban-runs-/);rmSync(path,{recursive:true,force:true});}
function fixture(){const root=mkdtempSync(join(tmpdir(),'kanban-runs-')),store=new Store(join(root,'test.sqlite')),runner=new ControlledRunner();let events=0;const runs=new Runs(store,runner,()=>events++);return {root,store,runner,runs,events:()=>events,close:()=>{runs.close();store.close();cleanup(root);}};}
function code(fn:()=>unknown,expected:number){assert.throws(fn,(e:unknown)=>e instanceof AppError&&e.status===expected);}

test('run lifecycle: scope, immutable result, human judgement, concurrency and rejection input',()=>{
  const f=fixture();const {store,runner,runs}=f;
  try {
    const agents=store.agents(), task=store.createTask({title:'first',agentId:agents[0].id}),second=store.createTask({title:'second',agentId:agents[0].id}),other=store.createTask({title:'other',agentId:agents[1].id});
    const run=runs.launch(task.id,{expectedVersion:1}),token=runner.token(run.id);
    assert.equal(store.task(task.id).status,'todo');code(()=>runs.launch(second.id,{expectedVersion:1}),409);assert.equal(runs.list(second.id).length,0);assert.equal(store.history(second.id).length,1);
    const parallel=runs.launch(other.id,{expectedVersion:1});assert.equal(parallel.state,'launching');
    code(()=>runs.assigned(token,parallel.id),403);code(()=>runs.assigned(undefined,run.id),401);
    assert.equal(runs.assigned(token,run.id).task.id,task.id);
    runs.start(token,run.id,{});const before=store.history(task.id);runs.start(token,run.id,{});assert.deepEqual(store.history(task.id),before);
    code(()=>runs.submit(token,run.id,{summary:'bad',changedFiles:['../db.sqlite'],tests:result.tests}),400);assert.equal(store.task(task.id).status,'in_progress');assert.deepEqual(store.history(task.id),before);
    assert.equal(runs.submit(token,run.id,result).status,'review');const submitted=store.history(task.id);
    code(()=>runs.submit(token,run.id,result),401);assert.deepEqual(store.history(task.id),submitted);
    code(()=>runs.judge(task.id,{expectedVersion:store.task(task.id).version},true),409);
    assert.throws(()=>store.db.exec("UPDATE results SET summary='fake'"));assert.throws(()=>store.db.exec('DELETE FROM results'));
    runner.end(run.id,'failed','CLI failed after submission');assert.equal(store.task(task.id).status,'review');assert.equal(runs.result(run.id)!.summary,result.summary);
    code(()=>runs.judge(task.id,{expectedVersion:store.task(task.id).version,reason:'   '},false),400);
    code(()=>runs.judge(task.id,{expectedVersion:1,reason:'재작업'},false),409);
    const reason='누락된 검증을 추가해 주세요.';runs.judge(task.id,{expectedVersion:store.task(task.id).version,reason},false);
    assert.equal(store.task(task.id).status,'todo');assert.equal(runs.list(task.id).length,1);
    const rework=runs.launch(task.id,{expectedVersion:store.task(task.id).version});assert.equal(runner.contexts.get(rework.id)!.rejectionReason,reason);
    code(()=>runs.submit(token,rework.id,result),401);runs.start(runner.token(rework.id),rework.id,{});runs.submit(runner.token(rework.id),rework.id,result);runner.end(rework.id);
    assert.equal(runs.judge(task.id,{expectedVersion:store.task(task.id).version},true).status,'done');
    assert.equal(store.history(task.id)[0].actorType,'human');assert.equal(store.history(task.id)[0].toStatus,'done');
    code(()=>runs.launch(task.id,{expectedVersion:store.task(task.id).version}),409);
  }finally{f.close();}
});

test('run failure/cancel/restart: confirmed tree exit, no retry, stale capability and retained occupancy',()=>{
  const f=fixture();const {store,runner,runs}=f;
  try {
    const agent=store.agents()[0],task=store.createTask({title:'failure',agentId:agent.id});
    let run=runs.launch(task.id,{expectedVersion:1}),token=runner.token(run.id);runs.start(token,run.id,{});
    runner.end(run.id,'failed','process failed');assert.equal(store.task(task.id).status,'todo');assert.equal(runs.list(task.id).length,1);
    assert.equal(store.history(task.id)[0].fromStatus,'in_progress');assert.equal(store.history(task.id)[0].toStatus,'todo');code(()=>runs.start(token,run.id,{}),401);
    run=runs.launch(task.id,{expectedVersion:store.task(task.id).version});token=runner.token(run.id);runs.start(token,run.id,{});
    runs.cancel(run.id,{});assert.deepEqual(runner.cancelled,[run.id]);code(()=>runs.submit(token,run.id,result),401);
    runner.end(run.id,'cancelled','tree not yet confirmed',false);assert.equal(store.task(task.id).status,'in_progress');code(()=>runs.launch(task.id,{expectedVersion:store.task(task.id).version}),409);
    runner.end(run.id,'cancelled','human cancel',true);assert.equal(store.task(task.id).status,'todo');assert.equal(runs.list(task.id).length,2);
    run=runs.launch(task.id,{expectedVersion:store.task(task.id).version});token=runner.token(run.id);runs.start(token,run.id,{});
    runs.close();const restarted=new Runs(store,runner,()=>{});
    try{code(()=>restarted.assigned(token,run.id),401);code(()=>restarted.launch(task.id,{expectedVersion:store.task(task.id).version}),409);
      restarted.finish(run.id,'interrupted','restart termination confirmed',true);assert.equal(store.task(task.id).status,'todo');assert.equal(runs.list(task.id).length,3);
    }finally{restarted.close();}
  }finally{f.close();}
});

test('HTTP agent boundary: valid capability cannot impersonate human or touch another run',async()=>{
  const root=mkdtempSync(join(tmpdir(),'kanban-runs-')),runner=new ControlledRunner(),service=createApp({dbPath:join(root,'test.sqlite'),password:'http-run-test-password',runner}),server=service.app.listen(0,'127.0.0.1');
  await new Promise<void>(r=>server.once('listening',r));const address=server.address();assert(address&&typeof address!=='string');const base=`http://127.0.0.1:${address.port}`;
  let cookie='',csrf='';
  async function human(path:string,method='GET',body?:unknown){return fetch(base+path,{method,headers:{origin:base,cookie,'x-csrf-token':csrf,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(5000)});}
  async function agent(path:string,token:string,method='GET',body?:unknown){return fetch(base+path,{method,headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(5000)});}
  try{
    const login=await human('/api/session','POST',{password:'http-run-test-password'});cookie=login.headers.get('set-cookie')!.split(';')[0];csrf=(await login.json()).csrfToken;
    const task=service.store.createTask({title:'HTTP run',agentId:service.store.agents()[0].id});
    const started=await human(`/api/tasks/${task.id}/runs`,'POST',{expectedVersion:1});assert.equal(started.status,202);const run=(await started.json()).run,token=runner.token(run.id);
    assert.equal((await agent(`/api/agent/runs/${run.id}/task`,token)).status,200);
    const before=service.store.history(task.id);
    for(const [path,method,body] of [[`/api/tasks/${task.id}/approve`,'POST',{expectedVersion:2,role:'human'}],['/api/tasks','GET',undefined],[`/api/tasks/${task.id}/history`,'DELETE',{}],['/api/tasks','POST',{title:'stolen',agentId:task.agentId}]] as const)assert.equal((await agent(path,token,method,body)).status,403);
    assert.equal((await agent('/api/agent/runs/other/task',token)).status,403);assert.deepEqual(service.store.history(task.id),before);
    assert.equal((await agent(`/api/agent/runs/${run.id}/start`,token,'POST',{})).status,200);
    assert.equal((await agent(`/api/agent/runs/${run.id}/result`,token,'POST',result)).status,200);
    assert.equal((await human(`/api/tasks/${task.id}/approve`,'POST',{expectedVersion:service.store.task(task.id).version})).status,409);
    runner.end(run.id);assert.equal((await human(`/api/tasks/${task.id}/approve`,'POST',{expectedVersion:service.store.task(task.id).version})).status,200);
    const rejected=await agent(`/api/agent/runs/${run.id}/result`,token,'POST',result);assert.equal(rejected.status,401);assert.equal(service.store.task(task.id).status,'done');
    console.log(`verified run API address: ${base}; temp DB: ${service.store.path}`);
  }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));service.close();cleanup(root);}
});

test('unverified isolation: production runner rejects execution without task/history changes',()=>{
  const f=fixture();try{
    const runs=new Runs(f.store,new DisabledRunner(),()=>{}),task=f.store.createTask({title:'protected',agentId:f.store.agents()[0].id}),before=f.store.history(task.id);
    try{code(()=>runs.launch(task.id,{expectedVersion:1}),503);assert.equal(runs.list(task.id).length,0);assert.deepEqual(f.store.history(task.id),before);assert.equal(f.store.task(task.id).version,1);}finally{runs.close();}
  }finally{f.close();}
});
