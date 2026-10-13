import express, { type Request, type Response, type NextFunction } from 'express';
import { resolve } from 'node:path';
import { Store } from './store.js';
import { Auth, setPassword } from './auth.js';
import { AppError, input } from '../shared/contracts.js';
import { Runs, DisabledRunner, type Runner } from './runs.js';

export function createApp(options:{dbPath:string;password?:string;runner?:Runner}) {
  const store=new Store(options.dbPath), auth=new Auth(store);
  if(options.password) setPassword(store,options.password);
  const app=express(), streams=new Set<Response>();
  app.disable('x-powered-by');
  app.use((req,res,next)=>{
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'");
    const host=req.headers.host??'';
    if(!/^127\.0\.0\.1(?::\d+)?$/.test(host))return next(new AppError(403,'HOST','허용되지 않은 호스트입니다.'));
    const origin=`http://${host}`;
    if(req.headers.origin && req.headers.origin!==origin)return next(new AppError(403,'ORIGIN','허용되지 않은 출처입니다.'));
    if(!['GET','HEAD'].includes(req.method)&&req.headers.origin!==origin&&!req.headers.authorization)return next(new AppError(403,'ORIGIN','변경 요청에 동일 출처가 필요합니다.'));
    next();
  });
  app.use(express.json({limit:'128kb'}));
  const emit=(event:string)=>{for(const stream of streams)stream.write(`event: ${event}\ndata: {}\n\n`);};
  const runs=new Runs(store,options.runner??new DisabledRunner(),()=>emit('tasks-changed'));
  app.post('/api/session',(req,res)=>{
    if(req.headers.authorization)throw new AppError(403,'FORBIDDEN','실행 권한으로 로그인할 수 없습니다.');
    const data=input(req.body,['password']), session=auth.login(data.password);
    res.cookie('kanban_session',session.token,{httpOnly:true,sameSite:'strict',path:'/',maxAge:8*60*60*1000});
    res.setHeader('Cache-Control','no-store');res.json({csrfToken:session.csrf});
  });
  const bearer=(req:Request)=>/^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization??'')?.[1];
  app.get('/api/agent/runs/:id/task',(req,res)=>res.json(runs.assigned(bearer(req),String(req.params.id))));
  app.post('/api/agent/runs/:id/start',(req,res)=>res.json({task:runs.start(bearer(req),String(req.params.id),req.body)}));
  app.post('/api/agent/runs/:id/result',(req,res)=>res.json({task:runs.submit(bearer(req),String(req.params.id),req.body)}));
  app.use('/api/agent',()=>{throw new AppError(403,'FORBIDDEN','에이전트에게 허용되지 않은 동작입니다.');});
  app.use('/api',(req,res,next)=>{res.setHeader('Cache-Control','no-store');auth.human(req);next();});
  app.get('/api/session',(req,res)=>res.json({csrfToken:auth.session(req).csrf}));
  app.delete('/api/session',(req,res)=>{auth.logout(req);res.clearCookie('kanban_session',{path:'/'});res.sendStatus(204);});
  app.get('/api/tasks',(_req,res)=>res.json({tasks:store.tasks()}));
  app.post('/api/tasks',(req,res)=>{const task=store.createTask(req.body);emit('tasks-changed');res.status(201).json({task});});
  app.get('/api/tasks/:id/history',(req,res)=>res.json({history:store.history(String(req.params.id))}));
  app.get('/api/tasks/:id/runs',(req,res)=>res.json({runs:runs.list(String(req.params.id))}));
  app.post('/api/tasks/:id/runs',(req,res)=>res.status(202).json({run:runs.launch(String(req.params.id),req.body)}));
  app.post('/api/tasks/:id/approve',(req,res)=>res.json({task:runs.judge(String(req.params.id),req.body,true)}));
  app.post('/api/tasks/:id/reject',(req,res)=>res.json({task:runs.judge(String(req.params.id),req.body,false)}));
  app.post('/api/runs/:id/cancel',(req,res)=>res.status(202).json({run:runs.cancel(String(req.params.id),req.body)}));
  app.get('/api/agents',(_req,res)=>res.json({agents:store.agents()}));
  app.post('/api/agents',(req,res)=>{const agent=store.addAgent(req.body);emit('agents-changed');res.status(201).json({agent});});
  app.patch('/api/agents/:id',(req,res)=>{const agent=store.editAgent(String(req.params.id),req.body);emit('agents-changed');res.json({agent});});
  app.delete('/api/agents/:id',(req,res)=>{store.deleteAgent(String(req.params.id));emit('agents-changed');res.sendStatus(204);});
  app.get('/api/events',(req,res)=>{
    res.setHeader('Content-Type','text/event-stream');res.setHeader('Cache-Control','no-cache');res.flushHeaders();
    res.write('event: connected\ndata: {}\n\n');streams.add(res);
    const timer=setInterval(()=>{try {auth.human(req);res.write(': heartbeat\n\n');}catch{res.end();}},15000);
    res.on('close',()=>{clearInterval(timer);streams.delete(res);});
  });
  app.use('/api',()=>{throw new AppError(404,'NOT_FOUND','제공하지 않는 API입니다.');});
  app.use(express.static(resolve('dist')));
  app.use((error:unknown,_req:Request,res:Response,_next:NextFunction)=>{
    if(res.headersSent){res.end();return;}
    const e=error instanceof AppError?error: error instanceof SyntaxError?new AppError(400,'INVALID_JSON','JSON 형식이 잘못되었습니다.'):new AppError(500,'INTERNAL','서버 오류입니다.');
    res.status(e.status).json({error:{code:e.code,message:e.message}});
  });
  return {app,store,auth,runs,close:()=>{for(const stream of streams)stream.end();runs.close();auth.clear();store.close();}};
}
