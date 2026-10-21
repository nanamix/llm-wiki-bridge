# Changelog

## Unreleased

### 추가

- 의존성 설치 없이 실행하는 Node.js 회귀 테스트 15개와 `npm test`·`npm run check` 명령 추가
- GitHub Actions에 JavaScript 구문 검사와 테스트 실행 등록

### 변경

- 하네스 기본 경로를 `~/.ai-harness`로 변경. 저장된 이전 기본값 `~/.ai_harness`만 이관하고 사용자 지정 경로는 보존
- 진행 모달은 최근 256 Ki 문자만 유지하도록 로그 누적 제한
- 확인 모달과 실행 제목에 선택한 Refine 에이전트를 표시
- 보안 문서에 실제 실행 경계와 취약점 제보 안내를 작성하고 Dependabot를 GitHub Actions 업데이트 대상으로 설정

### 수정

- `0000_JOURNAL/YYYY/MM/Www/YYYY-MM-DD/` 저널 집계 지원. 기존 월별 직속·날짜 폴더도 지원하며 `-00` 인덱스·디렉터리·동일 파일명 복사본은 제외
- 저널 읽기 오류를 0건과 구분하여 확인 모달에 집계 실패로 표시
- 명령별 사전 점검을 분리하여 위키 생성만 실행할 때 불필요한 `wiki-now.sh` 요구 제거
- `wiki`와 Refine 스크립트의 실행권한, 런처의 읽기 권한을 확인하고 `codex-cli` 선택 시에만 Codex CLI 검사
- 원샷 첫 단계 실패 후 두 번째 단계가 성공해도 전체 성공으로 표시하지 않도록 첫 단계 종료 코드와 오류 상태 보존

### 검증

- 로컬 테스트 15개, JavaScript 구문 검사, YAML 구문 검사, `git diff --check` 통과
- 실제 Obsidian 설치본과 원격 GitHub Actions 실행은 미검증

## 0.1.0

- 최초 공개 버전
- `wiki-now.sh --safe` 안전 점검 명령 추가
- `wiki-now.sh` 전체 정제 명령 추가
- `wiki refine-scan --agent codex-cli` 위키 생성 명령 추가
- 전체 정제 + 위키 생성 원샷 명령 추가
- 진행 로그 모달, 확인 모달, 설정 탭 추가
