import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import type { Store } from './store.js';
import { AppError } from '../shared/contracts.js';

export function setPassword(store: Store, password: string) {
  if(password.length<12 || password.length>1024) throw new AppError(400,'PASSWORD_LENGTH','비밀번호는 12~1024자여야 합니다.');
  if(store.db.prepare('SELECT id FROM owner_credentials WHERE id=1').get()) throw new AppError(409,'ALREADY_SETUP','소유자 비밀번호가 이미 설정되어 있습니다.');
  const salt=randomBytes(16).toString('hex'), hash=scryptSync(password,salt,64).toString('hex');
  store.db.prepare('INSERT INTO owner_credentials VALUES(1,?,?)').run(`${salt}:${hash}`,new Date().toISOString());
}
export class Auth {
  private sessions=new Map<string,{csrf:string,expires:number}>();
  private failures=0;
  private lockedUntil=0;
  constructor(private store:Store) {}
  login(password:unknown) {
    if(Date.now()<this.lockedUntil) throw new AppError(429,'LOGIN_LIMIT','잠시 후 다시 로그인하세요.');
    const row=this.store.db.prepare('SELECT password_hash FROM owner_credentials WHERE id=1').get() as {password_hash:string}|undefined;
    if(!row) throw new AppError(503,'SETUP_REQUIRED','서버에서 소유자 비밀번호를 먼저 설정하세요.');
    if(typeof password!=='string'||password.length>1024)throw new AppError(400,'INVALID_INPUT','비밀번호 형식이 잘못되었습니다.');
    const [salt,hash]=row.password_hash.split(':');
    if(!timingSafeEqual(scryptSync(password,salt,64),Buffer.from(hash,'hex'))) {
      this.failures++; if(this.failures>=5){this.lockedUntil=Date.now()+60000;this.failures=0;}
      throw new AppError(401,'LOGIN_FAILED','비밀번호가 일치하지 않습니다.');
    }
    this.failures=0;
    const token=randomBytes(32).toString('hex'), csrf=randomBytes(32).toString('hex');
    this.sessions.set(token,{csrf,expires:Date.now()+8*60*60*1000});return {token,csrf};
  }
  token(req:Request) {return /(?:^|;\s*)kanban_session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie??'')?.[1];}
  session(req:Request) {
    const token=this.token(req), session=token?this.sessions.get(token):undefined;
    if(!session||session.expires<=Date.now()){if(token)this.sessions.delete(token);throw new AppError(401,'UNAUTHENTICATED','로그인이 필요합니다.');}
    return session;
  }
  human(req:Request) {
    // A bearer credential must never be upgraded through a human cookie.
    if(req.headers.authorization) throw new AppError(403,'FORBIDDEN','이 경로는 사람 세션 전용입니다.');
    const session=this.session(req);
    if(!['GET','HEAD'].includes(req.method)&&req.headers['x-csrf-token']!==session.csrf)throw new AppError(403,'CSRF','요청 검증에 실패했습니다.');
    return session;
  }
  logout(req:Request) {const token=this.token(req);if(token)this.sessions.delete(token);}
  clear() {this.sessions.clear();}
}
