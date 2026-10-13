# AI Agent Kanban Board

현재 구현 중이다. 사람 로그인, 작업 생성·조회, 에이전트 관리, 불변 생성 이력과 SSE 서버를 작성했다. 실행·결과 제출·판정·React UI·Windows 격리 및 실제 CLI 연동은 다음 구현 단계이며 전체 목표가 완료된 상태는 아니다.

## 환경과 실행

Node.js 24 이상과 npm을 사용한다. Git 저장소는 필요하지 않다.

```powershell
Set-Location C:\project\hackathon
npm install --no-audit --no-fund
npm run build:server
./scripts/setup-owner.ps1
npm start
```

설정 스크립트는 숨김 입력으로 비밀번호를 받고 표준 입력으로 설정 프로그램에 전달한다. 12자 이상을 사용한다. 원문 비밀번호를 CLI 인자나 DB에 저장하지 않는다. 이미 설정된 비밀번호는 덮어쓰지 않는다. HTTP 초기 설정 API는 없다.

기본 서버 주소는 http://127.0.0.1:3000이다. 현재 UI가 없어 브라우저 보드 사용은 아직 불가능하다. `POST /api/session`에 `{password}`를 보내 로그인한 뒤 쿠키와 응답의 csrfToken을 사용한다. 변경 요청에는 동일 출처 Origin과 X-CSRF-Token 헤더가 필요하다. 사람용 API에 Bearer 헤더를 함께 보내면 거부한다.

DB 기본 경로는 data/kanban.sqlite이다. 서버 설정 KANBAN_DB로 경로, KANBAN_PORT로 포트를 지정할 수 있다. 초기 에이전트 3개만 생성한다. 샘플 작업은 만들지 않는다. 서버 재시작 시 사람 세션은 만료되며 다시 로그인한다.

## 테스트

```powershell
npm test
```

각 테스트는 OS 임시 폴더의 파일 기반 SQLite와 별도 루프백 포트를 사용한다. 실제 사용자 DB는 변경하지 않는다. 테스트 후 생성한 임시 경로를 확인하여 정리한다. 상태 전이·실행 권한·실제 CLI·OS 격리·UI는 아직 검증되지 않았다. 테스트 기록은 docs/test-records에 보관한다.

## 다음 단계

1. 실행 회차·작업별 제한 권한·더미 실행 및 승인·반려 검증.
2. React 보드와 실행·검토·에이전트 관리 화면.
3. Windows 전용 계정·ACL·프로필·Job Object의 구현과 환경 검증.
4. 격리된 계정에서 CLI 로그인·실제 codex exec 연동 검증.

OS 격리를 검증하기 전에는 실제 CLI 실행을 연결하지 않는다. 현재 실행 코드는 없다. 상세 요구는 docs/specs/my-feature.md, 계약은 docs/design.md를 따른다.
