# 사람이 배정하고 판정하는 AI 에이전트 작업 보드

## 현재 목표의 변경과 진행 — 2026-10-13

사용자는 코드 수정·의존성 설치·로컬 서버 실행·테스트·실제 codex exec 연동 검증을 허용했다. 아래 구현 전·코드 수정 금지 표현은 이전 단계 기록이다. 전체 목표는 설계·구현·실행·검증이며 생성·조회 단계만으로 완료 처리하지 않는다.

이번 채팅에서 실행 정책을 명시적으로 재확정했다: 회차 제한 30분, 실패·취소·시간 초과 시 프로세스 종료 확인 후 결과 없는 작업 Todo 복귀, 제출 결과는 이후 실패에도 Review 보존, 프로세스 종료 전 에이전트 재실행·사람 판정 차단, 재시작 시 기존 실행 종료 확인과 결과 없는 작업 Todo 복귀, 자동 재실행 없음.

현재 목표의 샘플 배치 미결 조건을 우선해 자동 작업 시드는 하지 않는다. 초기 에이전트는 기획 📋·개발 💻·검토 🔍다. 사람 인증·에이전트 관리·작업 생성·SQLite 이력·SSE를 작성 중이며 실제 실행 근거는 테스트 기록에 별도로 남긴다.

상태: 설계 확정·구현 전. 사용자 직접 선택과 ‘적당한 결정을 해서 마무리’ 위임에 따른 결정을 반영했다. 코드 수정·외부 이슈 게시·실제 CLI 작업 실행은 하지 않았다. 구현 계약과 SQLite 스키마는 [설계 문서](../design.md)를 따른다.

## HTML 다이어그램

[브라우저에서 보기](./my-feature.html). 카드 하나는 작업 하나이며 열 하나는 상태 하나다.

<!-- spec-diagram:start -->
<div lang="ko" aria-label="사람과 에이전트의 역할 및 칸반 기능 명세" style="font-family:system-ui,sans-serif;line-height:1.65;max-width:1100px;margin:auto;color:#172033;background:#f8fafc;padding:24px;border-radius:16px;">
  <h1 style="font-size:24px;margin-top:0;">사람은 맡기고 판정합니다. 에이전트는 실행합니다.</h1>
  <div aria-label="네 상태 흐름" style="display:flex;flex-wrap:wrap;gap:12px;align-items:center;margin-bottom:20px;">
    <div><strong>Todo</strong><br>할 일 · 맡긴 일</div><span aria-hidden="true">→</span>
    <div><strong>In Progress</strong><br>하는 중 · 하고 있는 일</div><span aria-hidden="true">→</span>
    <div><strong>Review</strong><br>검토 대기 · 끝냈다고 올린 일</div><span aria-hidden="true">→</span>
    <div><strong>Done</strong><br>완료 · 확인이 끝난 일</div>
  </div>
  <p>Review에서 사람 반려 → 이유를 보존하고 Todo로 이동 → 사람의 재실행 지시 → 에이전트가 이유를 읽고 재작업. 자동 재실행하지 않습니다.</p>
  <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,280px),1fr));gap:16px;">
    <section aria-labelledby="problem" style="background:#fff;padding:20px;border:1px solid #cbd5e1;border-radius:12px;">
      <h2 id="problem">1. 문제</h2><p>AI가 실행한 일과 사람이 확인한 완료를 구분하고, 에이전트의 배정·판정 권한 우회와 기록 삭제를 막아야 합니다.</p>
    </section>
    <section aria-labelledby="users" style="background:#fff;padding:20px;border:1px solid #cbd5e1;border-radius:12px;">
      <h2 id="users">2. 사용자</h2><p>사람: 배정·승인·반려.<br>에이전트: 맡은 작업 조회·시작·결과 제출.<br>서버: 작업별 codex exec 실행, 권한과 이력 관리.</p>
    </section>
    <section aria-labelledby="goals" style="background:#fff;padding:20px;border:1px solid #cbd5e1;border-radius:12px;">
      <h2 id="goals">3. 목표</h2><p>사람 배정 → 에이전트 실행 → 결과 제출 → 사람 판정. 반려 이유를 재작업에 전달하고 모든 이동을 지울 수 없는 기록으로 보존합니다.</p>
    </section>
    <section aria-labelledby="scope" style="background:#fff;padding:20px;border:1px solid #cbd5e1;border-radius:12px;">
      <h2 id="scope">4. 범위</h2><ul><li>네 열, 모든 작업의 담당자는 에이전트</li><li>제목·담당 에이전트 필수, 상세 내용 선택, Todo로 생성</li><li>사람의 배정·승인·이유를 포함한 반려</li><li>담당 작업 조회·시작·제출만 허용하는 에이전트 API</li><li>제출 결과: 작업 요약·변경 파일 목록·테스트 결과. 실패·미실행도 명시하여 Review 제출 가능</li><li>서버의 codex exec 실행, 별도 OpenAI API 키 불필요</li><li>실패·30분 타임아웃·취소: 결과 없으면 Todo, 제출한 Review 결과는 보존. 자동 재실행 없음</li><li>에이전트별 한 작업 실행, 서로 다른 에이전트는 동시 실행 가능. 실행 중 추가 요청은 거부하며 대기열 없음</li><li>누가·언제·어디서 어디로 이동했는지 삭제 불가 기록으로 저장</li><li>사람 세션·회차별 토큰, 전용 OS 계정의 격리 검증 후 실제 실행</li><li>TypeScript·React·Node.js, 단일 로컬 서버, SQLite</li></ul>
    </section>
    <section aria-labelledby="excluded" style="background:#fff;padding:20px;border:1px solid #cbd5e1;border-radius:12px;">
      <h2 id="excluded">5. 범위 밖</h2><ul><li>Backlog·미배정</li><li>에이전트 자율 작업 가져가기·타 작업 접근</li><li>에이전트 완료·반려 판정</li><li>이동 기록 수정·삭제</li><li>Git 저장소·브랜치</li><li>이번 문서 정리 중 코드 수정·실제 작업 실행·외부 이슈 게시</li></ul>
    </section>
    <section aria-labelledby="scenarios" style="background:#fff;padding:20px;border:1px solid #cbd5e1;border-radius:12px;">
      <h2 id="scenarios">6. 확인할 시나리오</h2><p>정상: 사람 배정 → 사람의 실행 버튼 클릭 → 서버가 담당 작업의 codex exec 실행 → Review 제출 → 사람 승인으로 Done.</p><p>반려: 이유 입력 → Todo 복귀 → 사람의 재실행 지시 → 에이전트가 이유를 읽고 재작업 → 결과 재제출.</p><p>예외: 에이전트의 배정·완료·타 작업 접근·기록 삭제·사람 사칭을 서버에서 거부.</p>
    </section>
    <section aria-labelledby="done" style="background:#e8f3ed;padding:20px;border:1px solid #94bfa4;border-radius:12px;grid-column:1/-1;">
      <h2 id="done">7. 완료 기준</h2><ul><li>네 열과 사람·에이전트 권한이 UI·서버에서 일치.</li><li>결과 제출은 Review, Done은 사람 판정만 가능.</li><li>반려 이유 전달과 재작업 확인.</li><li>모든 이동의 행위자·시각·전이를 영속 저장하고 삭제 거부.</li><li>임시 SQLite의 허용·거부 테스트와 기록.</li><li>실제 CLI 연동과 API 권한 우회 방지·저장소 격리를 별도로 검증.</li></ul><p>첫 구현: 로그인·에이전트 목록·생성·조회·영속성·감사 기록·자동 테스트. 현재는 문서 확정이며 구현과 실행 검증은 아직 진행하지 않았습니다.</p>
    </section>
  </div>
</div>
<!-- spec-diagram:end -->

## 최신 사용자 결정: 권한 표

| 동작 | 사람 | 에이전트 | 서버 책임 |
| --- | --- | --- | --- |
| 배정 | 허용 | 금지 | 사람 권한 확인 |
| 자율로 작업 가져가기 | 해당 없음 | 금지 | claim 권한 제공 금지 |
| 작업 조회 | 보드 조회 | 담당 작업만 | 대상 작업 권한 확인 |
| 실행 시작 | 일을 맡김 | 담당 작업만 | 작업별 codex exec와 연결 |
| 결과 제출 | 검토함 | 담당 작업만 | 결과 보존·Review 이동 |
| 완료 판정 | 허용 | 금지 | 사람의 판정만 Done 반영 |
| 이유를 포함한 반려 | 허용 | 금지 | Review→Todo, 이유 보존, 자동 재실행 없음 |
| 이력 삭제·수정 | 금지 | 금지 | 기록을 지우는 우회도 차단 |

## 확인할 시나리오

| ID | 행동 | 기대 결과 |
| --- | --- | --- |
| N1 | 사람이 에이전트에게 배정한 뒤 실행 버튼 클릭 | 배정만으로 실행하지 않음. 사람의 클릭 후 서버가 해당 작업의 codex exec 실행. 담당자는 에이전트 |
| N0 | 사람이 제목과 담당 에이전트로 새 작업 생성 | 상세 내용 없이 생성 가능. 지정한 에이전트에게 배정된 Todo로 생성되며 자동 실행하지 않음 |
| N6 | 서로 다른 에이전트에 배정된 작업을 각각 실행 | 서로 다른 에이전트는 동시에 실행 가능. 각 에이전트의 활성 실행은 한 작업 이하 |
| N2 | 담당 에이전트가 시작·결과 제출 | In Progress에서 실행하고 작업 요약·변경 파일 목록·테스트 결과를 제출하여 Review로 이동. 자동 Done 없음 |
| N3 | 사람이 Review 승인 | Done 이동과 사람·시각·Review→Done 기록 |
| N4 | 사람이 Review에서 이유를 적어 반려한 뒤 다시 실행을 지시 | Todo 복귀, 이유 보존, 사람·시각·Review→Todo 기록. 지시 전 새 실행 없음. 지시 후 에이전트가 이유를 읽고 재작업 |
| N5 | 서버 재시작 | 작업·이력·제출 결과 유지. 이전 토큰 폐기와 실행 종료 확인. 결과 없는 회차는 중단 기록 후 Todo, Review 결과는 보존. 자동 재실행 없음 |
| E1 | 에이전트 자율 배정 | 서버 거부, 배정·상태 변화 없음 |
| E2 | 다른 작업 조회·시작·제출 | 서버 거부, 다른 작업 정보·실행 권한을 얻지 못함 |
| E3 | role 사칭·사람용 경로 호출로 완료·반려 | 서버에서 검증한 실제 권한으로 거부. Done 변화 없음 |
| E4 | 이유 없이 반려 | 거부, 상태 변화 없음 |
| E5 | 이력 삭제·변조 | API 및 SQL UPDATE/DELETE와 cascade 우회 거부. 전용 OS 계정에서 DB 직접 접근 거부를 별도 검증. 검증 전 실제 실행 비활성화 |
| E6 | codex exec가 결과 제출 전에 실패 | 오류와 이동을 기록하고 Todo로 복귀. 성공 결과·사람 승인을 만들지 않음. 자동 재시도하지 않고 사람의 재실행 지시를 기다림 |
| E7 | 중복·과거 실행의 결과 제출 | 제출 후 폐기된 토큰은 401, 현재 토큰의 다른 회차 접근은 403, 상태 충돌은 409. 결과·이력 덮어쓰기 없음 |
| E8 | 실행 중인 에이전트의 다른 작업 실행을 요청 | 서버가 거부. 두 번째 실행·대기열 등록·대상 작업 상태 이동 없음. 기존 실행 종료만으로 자동 실행하지 않으며 사람이 다시 지시해야 함 |
| N7 | 실패 또는 미실행 테스트를 명시한 유효 결과 제출 | Review에서 사람이 판정. 자동 Done·자동 반려 없음 |
| E9 | 테스트 결과·요약 등 필수 항목 누락 | 400, 결과·상태·이력 변화 없음. 유효한 제출 또는 실행 종료를 기다림 |
| E10 | 결과 제출 전 30분 초과·사람 취소 | 프로세스 트리 종료 확인 후 오류/사유 기록·Todo 복귀. 자동 재실행 없음 |
| E11 | 유효 결과 제출 후 CLI 오류 | Review 결과 보존, 회차 오류 표시. 프로세스 종료 전 승인·반려는 409 |
| E12 | 격리·CLI 로그인 설정 미충족 상태에서 실행 요청 | 503, 실제 프로세스를 실행하지 않음. 같은 사용자 실행으로 우회하지 않음 |

임시 SQLite로 테스트하고 실제 사용자 DB를 변경하지 않는다. API 검증과 실제 CLI·OS 격리 검증을 구분해 기록한다. 현재 문서는 테스트 결과가 아니다.

## 이전 결정의 변경

- 다섯 열 → 네 열. Backlog와 기본 Backlog 생성 폐기.
- 미배정 허용 → 담당 에이전트 필수.
- 단순 다음 단계 이동 → 역할별 동작·서버 권한 검사.
- 역방향 금지 → 사람이 이유를 적어 Review→Todo 반려 가능. 사람이 재실행을 지시하기 전에는 자동 실행하지 않음.
- 변경 주체 미기록 → 누가·언제·어디서 어디로 필수.
- 실행 연동 제외 → 작업별 codex exec.
- 무인증·경로만으로 역할 구분 → 최신 권한 차단 요구에 맞지 않아 그대로 사용 불가.
- 첫 구현 범위는 새 규칙에 맞춰 사람 로그인·에이전트 목록·생성·조회·영속성·생성 이력·자동 테스트로 확정. 전체 역할 흐름과 CLI·UI는 후속 단계.

## 위임에 따라 확정한 결정

| 항목 | 결정 |
| --- | --- |
| 테스트 실패·미실행 | 사실대로 명시하면 Review 제출 허용. 사람이 판정 |
| 결과 데이터 | summary, changedFiles, tests의 구조화된 데이터. 상세 형식은 설계 문서 |
| 실행 수명 | 프로세스 트리 종료까지 점유 유지. 종료 전 승인·반려 불가 |
| 타임아웃·취소 | 30분 제한, 사람만 취소. 결과 없으면 Todo, 결과 있으면 Review 보존 |
| 서버 재시작 | 토큰 폐기·이전 실행 종료 확인·중단 기록. 자동 재실행 없음 |
| 반려 재배정 | 허용하지 않음. 같은 담당자에게 이유를 전달하여 재실행 |
| 사람 인증 | 로컬 비밀번호·서버 세션. 실제 역할을 입력값으로 신뢰하지 않음 |
| 에이전트 인증 | 작업·에이전트·회차별 단기 토큰. 제출·종료 시 폐기 |
| Windows 실행 격리 | 전용 비관리자 계정·독립 작업 폴더·접근 제어·Job Object. 검증 전 실제 실행 비활성화 |
| 이력 | 서버 시각·행위자 ID/이름 스냅샷. 생성·이동·실패/취소 이벤트 append-only |
| ID·시간·동시 수정 | UUID·UTC ISO 8601·버전 충돌 409 |
| 스택 | Node.js 24·Express·Vite·npm·SSE·node:sqlite·node:test |
| 샘플 | 에이전트 3개·Todo 작업 5개, 최초 한 번만 생성. 다른 열의 가짜 실행 이력 없음 |
| 첫 구현 범위 | 사람 로그인·에이전트 목록·작업 생성/조회·SQLite 영속성·생성 감사 기록·자동 테스트 |

사용자 직접 선택한 네 열·역할·반려 정책·필수 입력·수동 실행·에이전트별 동시 제한·추가 요청 거부·결과 항목을 위임 결정이 변경하지 않는다. API·필드 제한·디렉터리·SQLite 스키마·오류 계약은 설계 문서에 기록했다.

## 환경 확인과 구현 대기 — 설계 미결과 구분

추가 기능 선택을 묻는 질문은 남기지 않는다. 다만 아래 사항은 문서만으로 확인할 수 없고 실제 구현·환경 검증이 필요하다.

- 전용 OS 계정·폴더 경로·ACL·프로세스 수명 제어·자격증명 격리를 실제로 설정하고 검증하기.
- 각 실행 계정에서 API 키 없이 CLI 로그인·작업 실행이 가능한지 확인하기. 자격증명을 다른 계정에서 임의 복사하지 않기.
- 실제 API·자동 테스트·UI·CLI 연동을 단계별 구현하고 실행 증거를 기록하기.
- 코드 수정 금지는 유지한다. 다음 구현 단계 진행을 요청받은 뒤 코드 작성하기.

위 항목이 끝나기 전에는 전체 프로토타입이나 보안 경계를 완료로 표시하지 않는다.

## 기술 확인 사실: 사용자 결정과 구분

로컬 CLI 도움말에서 비대화형 실행, JSONL, 구조화 결과, Git 검사 생략 옵션을 확인했다. 실제 CLI 작업 실행과 로그인 상태 확인은 하지 않았다.

공식 문서는 ChatGPT 로그인과 저장된 CLI 인증 재사용을 설명한다. 별도 OpenAI API 키 없이 연동하는 요구는 이를 활용해 설계할 수 있지만 실제 인증 전제는 확인이 필요하다. [인증](https://learn.chatgpt.com/docs/auth), [비대화형 실행](https://learn.chatgpt.com/docs/non-interactive-mode).
