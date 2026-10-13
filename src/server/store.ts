import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { AppError, input, textField, type Agent, type Task } from '../shared/contracts.js';

export class Store {
  readonly db: DatabaseSync;
  readonly path: string;
  constructor(path: string) {
    this.path = resolve(path);
    mkdirSync(dirname(this.path), {recursive:true});
    this.db = new DatabaseSync(this.path);
    this.db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS agents(id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, icon TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY,title TEXT NOT NULL,description TEXT NOT NULL,agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
        status TEXT NOT NULL CHECK(status IN ('todo','in_progress','review','done')), version INTEGER NOT NULL CHECK(version>=1),created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS task_events(id INTEGER PRIMARY KEY,task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,run_id TEXT,event_type TEXT NOT NULL,
        actor_type TEXT NOT NULL CHECK(actor_type IN ('human','agent','server')),actor_id TEXT NOT NULL,actor_name_snapshot TEXT NOT NULL,from_status TEXT,to_status TEXT NOT NULL,reason TEXT,happened_at TEXT NOT NULL);
      CREATE TRIGGER IF NOT EXISTS events_no_update BEFORE UPDATE ON task_events BEGIN SELECT RAISE(ABORT,'immutable history'); END;
      CREATE TRIGGER IF NOT EXISTS events_no_delete BEFORE DELETE ON task_events BEGIN SELECT RAISE(ABORT,'immutable history'); END;
      CREATE TRIGGER IF NOT EXISTS task_no_edit BEFORE UPDATE OF title,description,agent_id ON tasks BEGIN SELECT RAISE(ABORT,'immutable task assignment'); END;
      CREATE TABLE IF NOT EXISTS owner_credentials(id INTEGER PRIMARY KEY CHECK(id=1),password_hash TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS app_metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS task_order ON tasks(created_at DESC,id DESC);
      CREATE INDEX IF NOT EXISTS event_order ON task_events(task_id,id DESC);`);
    this.transaction(() => {
      if (!this.db.prepare('SELECT value FROM app_metadata WHERE key=?').get('seeded')) {
        for (const [name, icon] of [['기획','📋'],['개발','💻'],['검토','🔍']]) this.addAgent({name,icon});
        this.db.prepare('INSERT INTO app_metadata VALUES(?,?)').run('seeded','1');
      }
    });
  }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {const result=fn(); this.db.exec('COMMIT'); return result;} catch(error) {this.db.exec('ROLLBACK'); throw error;}
  }
  agents(): Agent[] { return this.db.prepare('SELECT id,name,icon,created_at AS createdAt,updated_at AS updatedAt FROM agents ORDER BY created_at,id').all() as unknown as Agent[]; }
  agent(id: string): Agent {const a=this.agents().find(a=>a.id===id); if(!a) throw new AppError(404,'NOT_FOUND','에이전트가 없습니다.'); return a;}
  addAgent(value: unknown): Agent {
    const data=input(value,['name','icon']); const name=textField(data.name,'이름',80), icon=textField(data.icon,'아이콘',32);
    if (this.db.prepare('SELECT id FROM agents WHERE name=?').get(name)) throw new AppError(409,'DUPLICATE_AGENT','이름이 이미 등록되어 있습니다.');
    const id=randomUUID(), time=new Date().toISOString();
    this.db.prepare('INSERT INTO agents VALUES(?,?,?,?,?)').run(id,name,icon,time,time); return this.agent(id);
  }
  editAgent(id:string, value:unknown): Agent {
    const old=this.agent(id), data=input(value,['name','icon']);
    if (!Object.keys(data).length) throw new AppError(400,'INVALID_INPUT','변경할 값이 필요합니다.');
    const name=data.name===undefined?old.name:textField(data.name,'이름',80), icon=data.icon===undefined?old.icon:textField(data.icon,'아이콘',32);
    if(this.db.prepare('SELECT id FROM agents WHERE name=? AND id<>?').get(name,id)) throw new AppError(409,'DUPLICATE_AGENT','이름이 이미 등록되어 있습니다.');
    this.db.prepare('UPDATE agents SET name=?,icon=?,updated_at=? WHERE id=?').run(name,icon,new Date().toISOString(),id); return this.agent(id);
  }
  deleteAgent(id:string): void {
    this.agent(id);
    if(this.db.prepare('SELECT id FROM tasks WHERE agent_id=? LIMIT 1').get(id)) throw new AppError(409,'AGENT_ASSIGNED','배정된 에이전트는 삭제할 수 없습니다.');
    this.db.prepare('DELETE FROM agents WHERE id=?').run(id);
  }
  tasks(): Task[] {return this.db.prepare('SELECT id,title,description,agent_id AS agentId,status,version,created_at AS createdAt,updated_at AS updatedAt FROM tasks ORDER BY created_at DESC,id DESC').all() as unknown as Task[];}
  task(id:string): Task {const t=this.tasks().find(t=>t.id===id);if(!t)throw new AppError(404,'NOT_FOUND','작업이 없습니다.');return t;}
  createTask(value: unknown): Task {
    const data=input(value,['title','description','agentId']); const title=textField(data.title,'제목',200), description=textField(data.description,'상세 내용',10000,true), agentId=textField(data.agentId,'담당 에이전트',100);
    this.agent(agentId); const id=randomUUID(), time=new Date().toISOString();
    return this.transaction(()=>{
      this.db.prepare('INSERT INTO tasks VALUES(?,?,?,?,?,?,?,?)').run(id,title,description,agentId,'todo',1,time,time);
      this.db.prepare('INSERT INTO task_events(task_id,event_type,actor_type,actor_id,actor_name_snapshot,from_status,to_status,happened_at) VALUES(?,?,?,?,?,?,?,?)').run(id,'created','human','owner','소유자',null,'todo',time);
      return this.task(id);
    });
  }
  history(id:string) {this.task(id);return this.db.prepare('SELECT id,task_id AS taskId,run_id AS runId,event_type AS eventType,actor_type AS actorType,actor_id AS actorId,actor_name_snapshot AS actorNameSnapshot,from_status AS fromStatus,to_status AS toStatus,reason,happened_at AS happenedAt FROM task_events WHERE task_id=? ORDER BY id DESC').all(id);}
  close() {this.db.close();}
}
