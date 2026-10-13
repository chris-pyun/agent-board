# AI Agent Kanban Board — 확정 설계

## 현재 구현 진행 — 2026-10-13

현재 목표는 코드 수정·의존성 설치·로컬 서버 실행·테스트·실제 CLI 연동 검증을 허용한다. 아래의 '문서만 존재', '지금은 코드를 작성하지 않는다'는 이전 단계 기록이며 현재 제한이 아니다.

- 작성됨: TypeScript 서버 기반, SQLite 에이전트·작업·이력·소유자 인증 스키마, 작업 생성·조회, 에이전트 관리, 로그인·CSRF·Host/Origin 검사, SSE와 첫 통합 테스트.
- 사용자 재확인: 30분 제한·종료 확인·제출된 Review 보존·종료 전 점유/판정 제한·재시작 중단 정책.
- 아직 남음: 실행 회차와 권한, 더미 실행 수명 검증, React UI, Windows OS 격리, 실제 CLI 실행, 최종 검증·안내.
- 현재 목표에 따라 샘플 태스크 배치는 미확정이므로 자동 시드는 에이전트 3개만 생성한다.
- 실제 테스트 관찰은 docs/test-records/에 별도로 기록한다. 작성된 테스트와 실행된 테스트를 구분한다.

사용자의 ‘적당한 결정을 해서 마무리’ 위임에 따라 남은 설계 선택을 확정했다. 사용자 직접 선택과 위임 결정의 출처는 [명세](specs/my-feature.md)에 구분한다. 설계 확정은 코드 작성 또는 실제 실행의 완료를 뜻하지 않는다.

## 구조와 단계

```text
hackathon/
  AGENTS.md
  package.json / package-lock.json       # 구현 단계에서 생성
  src/shared/                           # 계약·상태·결과 타입
  src/server/
    app.ts / index.ts                   # 단일 루프백 서버
    db/                                 # SQLite 연결·마이그레이션·초기화
    services/                           # 작업·에이전트·판정·이력
    auth/                               # 사람 세션·회차별 권한
    runner/                             # 더미/실제 실행 관리자·Windows 격리 어댑터
    events.ts                           # SSE
  src/client/                           # React 보드·생성·검토·에이전트 관리
  tests/                                # 임시 DB·더미 실행·HTTP 통합 검증
  data/kanban.sqlite                    # 런타임 데이터, 에이전트 접근 금지
  docs/design.md
  docs/specs/my-feature.md / my-feature.html
  docs/test-records/                     # 실제 실행 시 결과 기록
  skills/kanban-api-test-record/SKILL.md
```

Node.js 24, npm, Express, React, Vite, TypeScript를 사용한다. SQLite는 Node.js의 `node:sqlite`를 사용한다. 테스트는 `node:test`로 작성하고 TypeScript 빌드 후 실행한다. 개발에서도 Vite는 파일 빌드·감시만 수행하고 UI는 Node.js가 제공한다. 기본 주소는 `http://127.0.0.1:3000`; 포트는 설정 가능하다. 실시간 반영은 SSE다.

현재는 문서만 존재한다. 첫 구현 단계의 범위는 사람 로그인, 에이전트 목록, 제목·담당자를 받는 작업 생성·조회, SQLite 영속성, 생성 감사 기록과 자동 테스트다. 다음 단계에서 더미 실행 기반 수명·권한·판정을 구현하고 실제 격리 실행을 연결한다. UI와 실행 안내는 그 뒤 순서로 진행한다. 지금은 코드를 작성하지 않는다.

## 데이터 계약과 SQLite 스키마

- ID는 UUID, 시간은 서버 생성 UTC ISO 8601. UI는 사용자 로컬 시간으로 표시한다.
- 상태 값은 `todo`, `in_progress`, `review`, `done`. 생성은 Todo로 고정한다.
- 제목은 trim 후 1~200자, 상세 내용은 기본 빈 문자열·최대 10,000자다. 담당 에이전트는 필수다.
- 에이전트 이름은 trim 후 1~80자·중복 금지, 아이콘은 이모지 문자열 1~32자다.
- 반려 이유는 trim 후 1~2,000자다. 생성 후 작업 제목·내용·담당자는 수정할 수 없으며 반려 후에도 재배정하지 않는다.

| 테이블 | 주요 필드와 제약 |
| --- | --- |
| agents | id PK, name UNIQUE, icon, created_at, updated_at. OS 실행 설정은 보호된 서버 설정으로 관리 |
| tasks | id PK, title, description, agent_id NOT NULL FK RESTRICT, status CHECK, version INTEGER >=1, created_at, updated_at |
| runs | id PK, task_id FK RESTRICT, agent_id FK RESTRICT, attempt, state, initiated_by, server_epoch, started_at, deadline_at, ended_at, error. UNIQUE(task_id,attempt) |
| results | id PK, run_id UNIQUE FK RESTRICT, summary, changed_files_json, tests_json, submitted_at. 제출 후 UPDATE/DELETE 금지 |
| task_events | id INTEGER PK, task_id FK RESTRICT, run_id nullable FK, event_type, actor_type, actor_id, actor_name_snapshot, from_status nullable, to_status, reason, happened_at. UPDATE/DELETE 금지 |
| owner_credentials | singleton ID, password_hash, created_at. 원문 비밀번호 미저장 |
| app_metadata | key PK, value. 스키마 버전·최초 시드 완료 표시 |

`runs.state`는 `launching/running/submitted/succeeded/failed/cancelled/interrupted`다. 에이전트별 launching/running/submitted 중 하나만 존재하도록 부분 UNIQUE 인덱스와 트랜잭션을 사용한다. `submitted`도 프로세스 트리가 종료될 때까지 활성 실행으로 취급한다. 작업별 회차·버전·에이전트 점유를 함께 확인한다.

작업은 `(created_at DESC,id DESC)`로 정렬한다. 이력은 `(task_id,id DESC)`, 회차는 `(task_id,attempt DESC)`로 조회한다. 외래 키 검사를 활성화하며 SQL은 파라미터 바인딩한다. 단계별 마이그레이션을 적용한다. 상태·버전·이력 변경을 하나의 트랜잭션으로 처리하고 커밋 후 SSE를 발행한다.

최초 시드는 에이전트 3개와 Todo 태스크 5개다. 다른 열에 가짜 실행 결과를 만들지 않는다. 컬럼별 표시는 더미 실행 테스트로 검증한다. 초기화 완료 표시를 사용해 사용자 데이터를 비워도 재시드하지 않는다.

## 실행과 판정

1. 사람이 Todo 작업의 실행 버튼을 누른다. 현재 버전을 확인하고 회차·에이전트 점유·단기 실행 권한을 만든다.
2. 서버가 담당 에이전트의 보호된 실행 설정과 전용 작업 폴더를 사용해 `codex exec`를 시작한다. CLI 인자는 서버가 구성하고 태스크 텍스트는 stdin으로 전달한다. 입력으로 임의 셸 명령·실행 파일·플래그를 지정할 수 없다.
3. 현재 회차 권한으로 시작을 확인하면 Todo→In Progress와 담당 에이전트 행위자를 기록한다. 시작 확인 전 프로세스 실패는 작업을 Todo로 유지하고 실행 실패 이벤트를 추가한다. 인증된 시작 요청은 새로운 회차를 스스로 생성할 수 없다.
4. 결과는 `{summary,changedFiles,tests}`다. summary는 비어 있지 않은 문자열, changedFiles는 작업 폴더 상대 경로 배열, tests는 `{name,status,details}` 배열이다. status는 `passed/failed/not_run`이며 테스트가 없으면 그 이유를 not_run으로 명시한다. 변경이 없으면 빈 파일 배열을 허용한다. 절대 경로·상위 경로 탈출은 거부하고 제출 경로를 자동 실행하지 않는다.
5. 형식이 유효하면 테스트 실패·미실행도 명시해서 Review로 제출할 수 있다. 서버는 보고된 테스트 결과의 진위를 자동 입증했다고 표시하지 않는다. 제출 결과는 변경하지 않으며 해당 회차 토큰은 폐기한다.
6. 실제 프로세스 트리가 종료될 때까지 에이전트 점유를 유지한다. 종료 전 사람의 승인·반려는 409로 거부한다. 종료가 확인된 Review만 사람이 승인하여 Done 또는 이유를 적어 Todo로 반려한다.
7. 반려 이유는 다음 회차 입력에 원문 그대로 포함하고 UI에서 확인한다. 사람이 재실행하기 전에는 실행을 만들지 않는다.

프로세스 종료만으로 결과 제출을 대체하지 않는다. 제한 시간은 회차당 30분이다. 결과가 없으면 exit code 0이어도 실행 실패로 처리한다. 결과 제출 전 실패·타임아웃·사람 취소는 프로세스 트리 종료를 확인한 뒤 오류/사유·서버 행위자를 기록하고 In Progress→Todo로 복귀한다. 종료 확인 실패는 새 실행을 거부하고 상태를 실행 중단 확인 대기로 표시한다.

이미 결과를 제출했다면 이후 실패·취소·타임아웃에도 Review 결과를 보존하고 회차 오류를 표시한다. 자동으로 Done이나 Todo로 덮어쓰지 않는다. 서버 재시작 시 이전 실행 권한을 폐기하고 이전 프로세스 종료를 확인한다. 결과 없는 실행은 interrupted로 종료해 Todo로 복귀하고 결과 있는 Review는 유지한다. 어떤 경우에도 자동 재실행하지 않는다.

## API 계약

| 메서드·경로 | 권한·동작 |
| --- | --- |
| POST /api/session | 사람 비밀번호 로그인, HttpOnly 세션 발급 |
| DELETE /api/session | 사람 로그아웃·세션 폐기 |
| GET /api/tasks | 사람 전용 전체 조회 |
| POST /api/tasks | 사람 전용 `{title,description?,agentId}` 생성, 201 |
| GET /api/tasks/:id/history | 사람 전용 생성·이동·실행 감사 이력 |
| GET /api/tasks/:id/runs | 사람 전용 회차·결과 조회 |
| POST /api/tasks/:id/runs | 사람 전용 `{expectedVersion}` 수동 실행, 202 |
| POST /api/tasks/:id/approve | 사람 전용 `{expectedVersion}` 승인 |
| POST /api/tasks/:id/reject | 사람 전용 `{expectedVersion,reason}` 반려 |
| POST /api/runs/:id/cancel | 사람 전용 취소, 202 |
| GET/POST /api/agents | 사람 전용 목록·등록 |
| PATCH/DELETE /api/agents/:id | 사람 전용 이름·아이콘 수정/미배정 에이전트 삭제 |
| GET /api/agent/runs/:id/task | 회차 토큰, 배정된 작업·반려 이유만 조회 |
| POST /api/agent/runs/:id/start | 회차 토큰, 현재 회차 시작 확인 |
| POST /api/agent/runs/:id/result | 회차 토큰, `{summary,changedFiles,tests}` 결과 제출 |
| GET /api/events | 사람 세션 전용 SSE |

범용 상태 PATCH·claim·작업 삭제·이력 수정/삭제 API는 제공하지 않는다. 목록은 `{tasks:[...]}` 등 해당 복수 이름, 단건은 `{task:...}` 등 해당 이름, 오류는 `{error:{code,message}}`로 응답한다. 필드는 camelCase다.

400은 입력·알 수 없는 필드·형식 오류, 401은 인증 누락/만료/폐기, 403은 인증된 주체의 허용되지 않은 동작, 404는 접근 가능한 범위에서 없는 리소스, 409는 버전·회차·상태·에이전트 점유·배정된 에이전트 삭제 충돌이다. 다른 작업에 대한 에이전트 접근은 리소스 존재와 무관하게 403이다. 설정·로그인·격리 전제 미충족 실행은 503으로 거부한다. 동일 회차의 시작 재요청은 부수 효과 없이 기존 결과를 반환한다. 결과 재전송은 폐기된 토큰으로 401이며 결과·이력을 추가하지 않는다. 미래 회차·과거 회차를 본문으로 바꾸어 호출할 수 없다.

SSE는 tasks-changed·agents-changed 알림을 보내고 클라이언트는 관련 목록을 재조회한다. 연결/재연결 시 전체 목록을 다시 조회한다. 과거 응답이 최신 목록을 덮어쓰지 않도록 요청 순번을 검사한다.

## 사람 인증과 실행 격리

사람은 최초 로컬 설정에서 정한 비밀번호로 로그인한다. 비밀번호는 scrypt 해시로 저장하고 세션은 서버 메모리에 둔다. 서버 재시작 시 재로그인한다. 쿠키는 HttpOnly·SameSite=Strict, HTTPS 사용 시 Secure를 적용한다. 변경 요청에 CSRF 검사·Origin/Host 검증을 함께 적용하되 이것만을 사람 인증으로 사용하지 않는다.

에이전트 토큰은 예측 불가능한 256비트 값이며 서버 메모리에서 작업·에이전트·회차·서버 epoch·허용 동작에 바인딩한다. 결과 제출·취소·실패·기한 만료·재시작 시 폐기한다. 토큰을 로그·UI·DB·CLI 인자에 남기지 않고 해당 격리 실행에만 전달한다. 로그인 권한이나 다른 회차의 토큰은 상속하지 않는다.

Windows에서는 에이전트별 전용 비관리자 OS 계정, 별도 사용자 프로필·작업 폴더, NTFS 접근 제어를 사용한다. 사람의 프로필·세션·서버 설정·소스·DB 및 다른 에이전트 폴더를 읽거나 쓸 수 없도록 한다. 실행은 다른 사용자 보안 컨텍스트로 만들고 Job Object에 연결하여 수명과 프로세스 트리를 관리한다. 관리자 권한의 호스트 사용자가 직접 DB를 변조하는 경우는 앱의 방어 범위 밖이다.

**계정·접근 제어·자격증명 격리·프로세스 수명 제어의 실환경 검증이 끝나기 전에는 실제 codex exec 실행을 비활성화한다.** 같은 사용자로 우회 실행하지 않는다. 전용 계정에서 CLI 로그인이 사용 가능해야 하며 별도 OpenAI API 키 입력을 요구하지 않는다. 현재 계정 생성·ACL 변경·로그인·모델 실행은 수행하지 않았다. OS 설정은 실제 적용 직전에 사용자와 실행 권한을 확인해야 하는 환경 작업이다.

직접 파일 수정뿐 아니라 SQL UPDATE/DELETE·부모 작업 삭제를 통한 cascade 우회도 거부한다. 감사 기록은 append-only이며 actor ID와 이름 스냅샷을 저장한다. 생성(null→Todo), 모든 이동 및 실패/취소 이벤트를 보존한다. 실패 요청은 민감값 없는 별도 운영 로그로 남긴다.

## 검증 계획과 실제 확인 상태

첫 단계는 생성 정상/제목 오류/담당자 누락·미존재/최근순/재시작 보존/인증 및 생성 이력 테스트다. 다음 단계는 더미 실행으로 정상 판정·반려·테스트 실패 제출·CLI 실패·타임아웃·취소·재시작·동시 실행·중복 요청·권한 위조·이력 변조를 검증한다. 마지막으로 실제 격리 사용자에서 보드·다른 에이전트 저장소 접근 거부와 허용된 작업 API·CLI 로그인을 확인한다. 테스트는 모두 임시 DB와 격리된 테스트 데이터로 수행한다.

읽기 전용 확인: Node.js v24.21.0, npm 11.19.0, codex CLI 도움말의 JSONL·구조화 결과·Git 검사 생략 옵션. PATH에 wsl.exe가 있으며 Docker·WindowsSandbox 명령은 찾지 못했다. 설치·실행 가능 여부는 별도 검증하지 않았다. 현재 애플리케이션·DB·자동 테스트·OS 격리·실제 CLI 연동은 미구현/미검증이다.

참고: [Codex 비대화형 실행](https://learn.chatgpt.com/docs/non-interactive-mode), [인증](https://learn.chatgpt.com/docs/auth), [Windows 프로세스 보안 컨텍스트](https://learn.microsoft.com/en-us/windows/win32/procthread/creating-processes), [Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects), [ACL](https://learn.microsoft.com/en-us/windows/win32/secauthz/access-control-lists). 이 자료는 메커니즘 설명이며 현재 환경에 대한 검증 증거가 아니다.
