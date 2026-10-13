import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { createApp } from '../src/server/app.js';
import { Store } from '../src/server/store.js';

function cleanup(root:string) {
  const target=resolve(root);
  assert.equal(dirname(target).toLowerCase(),resolve(tmpdir()).toLowerCase());
  assert.match(basename(target),/^kanban-(store|http|restart)-/);
  rmSync(target,{recursive:true,force:true});
}

test('file SQLite: assignment, immutable history, atomic creation, persistence and seed',()=>{
  const root=mkdtempSync(join(tmpdir(),'kanban-store-')),path=join(root,'test.sqlite');
  let store=new Store(path);
  try {
    assert.equal(store.agents().length,3); assert.equal(store.tasks().length,0);
    const agent=store.agents()[0];
    assert.throws(()=>store.createTask({title:'bad'}));assert.equal(store.tasks().length,0);
    const task=store.createTask({title:'정상',agentId:agent.id});
    assert.equal(task.status,'todo');assert.equal(task.description,'');assert.equal(store.history(task.id).length,1);
    assert.equal(store.history(task.id)[0].actor_type,undefined);assert.equal(store.history(task.id)[0].actorType,'human');
    assert.throws(()=>store.deleteAgent(agent.id));
    assert.throws(()=>store.db.prepare('DELETE FROM task_events WHERE task_id=?').run(task.id));
    assert.throws(()=>store.db.prepare('UPDATE task_events SET actor_id=? WHERE task_id=?').run('fake',task.id));
    assert.throws(()=>store.db.prepare('DELETE FROM tasks WHERE id=?').run(task.id));
    assert.throws(()=>store.db.prepare('UPDATE tasks SET title=? WHERE id=?').run('changed',task.id));
    store.db.exec("CREATE TRIGGER fail_event BEFORE INSERT ON task_events BEGIN SELECT RAISE(ABORT,'injected event failure'); END;");
    assert.throws(()=>store.createTask({title:'rollback',agentId:agent.id}));assert.equal(store.tasks().length,1);
    store.db.exec('DROP TRIGGER fail_event');store.close();store=new Store(path);
    assert.equal(store.task(task.id).title,'정상');assert.equal(store.history(task.id).length,1);assert.equal(store.agents().length,3);
    console.log(`verified temp DB: ${path}`);
  }finally{store.close();cleanup(root);}
});

test('HTTP: authentication, CSRF, validation, agent CRUD, logout and real SSE delivery',async()=>{
  const root=mkdtempSync(join(tmpdir(),'kanban-http-')),path=join(root,'test.sqlite');
  const service=createApp({dbPath:path,password:'local-test-password-123'}),server=service.app.listen(0,'127.0.0.1');
  await new Promise<void>(r=>server.once('listening',r));
  const address=server.address();assert(address&&typeof address!=='string');const base=`http://127.0.0.1:${address.port}`;
  let cookie='',csrf='';
  async function request(route:string,method='GET',body?:unknown,headers:Record<string,string>={}) {
    return fetch(base+route,{method,headers:{origin:base,'content-type':'application/json',cookie,'x-csrf-token':csrf,...headers},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(5000)});
  }
  try {
    assert.equal((await request('/api/tasks')).status,401);
    assert.equal((await request('/api/session','POST',{password:'wrong'})).status,401);
    const login=await request('/api/session','POST',{password:'local-test-password-123'});assert.equal(login.status,200);
    cookie=login.headers.get('set-cookie')!.split(';')[0];csrf=(await login.json()).csrfToken;
    const agents=(await (await request('/api/agents')).json()).agents;
    const before=(await (await request('/api/tasks')).json()).tasks;
    for(const body of [{title:''},{title:'missing'},{title:'bad',agentId:agents[0].id,status:'done'},{title:'bad',agentId:agents[0].id,role:'human'}])assert.equal((await request('/api/tasks','POST',body)).status,400);
    assert.equal((await request('/api/tasks','POST',{title:'bad',agentId:agents[0].id},{'x-csrf-token':''})).status,403);
    assert.equal((await request('/api/tasks','POST',{title:'bad',agentId:agents[0].id},{origin:'https://evil.example'})).status,403);
    assert.equal((await request('/api/tasks','POST',{title:'bad',agentId:agents[0].id},{authorization:'Bearer fake'})).status,403);
    assert.deepEqual((await (await request('/api/tasks')).json()).tasks,before);
    const controller=new AbortController(),stream=await fetch(base+'/api/events',{headers:{cookie},signal:controller.signal});
    const reader=stream.body!.getReader();await reader.read();
    const created=await request('/api/tasks','POST',{title:'HTTP task',agentId:agents[0].id});assert.equal(created.status,201);const task=(await created.json()).task;
    const event=await Promise.race([reader.read(),new Promise<never>((_,reject)=>setTimeout(()=>reject(new Error('SSE timeout')),2000))]);
    assert.match(new TextDecoder().decode(event.value),/tasks-changed/);controller.abort();
    const history=(await (await request(`/api/tasks/${task.id}/history`)).json()).history;assert.equal(history.length,1);assert.equal(history[0].actorType,'human');
    assert.equal((await request(`/api/agents/${agents[0].id}`,'DELETE')).status,409);
    assert.equal((await request(`/api/tasks/${task.id}`,'PATCH',{status:'done'})).status,404);
    const added=await request('/api/agents','POST',{name:'테스트',icon:'🧪'});assert.equal(added.status,201);const agent=(await added.json()).agent;
    assert.equal((await request('/api/agents','POST',{name:'테스트',icon:'🧪'})).status,409);
    assert.equal((await request(`/api/agents/${agent.id}`,'PATCH',{name:'테스트2'})).status,200);
    assert.equal((await request(`/api/agents/${agent.id}`,'DELETE')).status,204);
    assert.equal((await request('/api/session','DELETE')).status,204);assert.equal((await request('/api/tasks')).status,401);
    console.log(`verified HTTP address: ${base}; temp DB: ${path}`);
  }finally {server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));service.close();cleanup(root);}
});

test('HTTP server restart: persisted tasks/history and invalidated human session',async()=>{
  const root=mkdtempSync(join(tmpdir(),'kanban-restart-')),path=join(root,'test.sqlite');
  let service=createApp({dbPath:path,password:'restart-test-password'});
  let server=service.app.listen(0,'127.0.0.1');
  const address=async()=>{await new Promise<void>(r=>server.once('listening',r));const a=server.address();assert(a&&typeof a!=='string');return `http://127.0.0.1:${a.port}`;};
  let base=await address();
  const login=async()=>{const response=await fetch(base+'/api/session',{method:'POST',headers:{origin:base,'content-type':'application/json'},body:JSON.stringify({password:'restart-test-password'}),signal:AbortSignal.timeout(5000)});assert.equal(response.status,200);return {cookie:response.headers.get('set-cookie')!.split(';')[0],csrf:(await response.json()).csrfToken};};
  const close=async()=>{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));service.close();};
  try {
    const session=await login();
    const agent=service.store.agents()[0];
    const created=await fetch(base+'/api/tasks',{method:'POST',headers:{origin:base,'content-type':'application/json',cookie:session.cookie,'x-csrf-token':session.csrf},body:JSON.stringify({title:'persist over restart',agentId:agent.id}),signal:AbortSignal.timeout(5000)});
    assert.equal(created.status,201);const task=(await created.json()).task;
    await close();service=createApp({dbPath:path});server=service.app.listen(0,'127.0.0.1');base=await address();
    assert.equal((await fetch(base+'/api/tasks',{headers:{cookie:session.cookie},signal:AbortSignal.timeout(5000)})).status,401);
    const renewed=await login();const tasks=await fetch(base+'/api/tasks',{headers:{cookie:renewed.cookie},signal:AbortSignal.timeout(5000)});
    assert.equal(tasks.status,200);assert.equal((await tasks.json()).tasks[0].id,task.id);
    const history=await fetch(base+`/api/tasks/${task.id}/history`,{headers:{cookie:renewed.cookie},signal:AbortSignal.timeout(5000)});
    assert.equal((await history.json()).history.length,1);
    console.log(`verified restarted HTTP server: ${base}; temp DB: ${path}`);
  }finally{await close();cleanup(root);}
});
