# LLM Wiki Bridge

> Obsidian에서 로컬 LLM-Wiki 하네스의 안전 점검·전체 정제·위키 생성을 실행하는 데스크톱 플러그인

## 목차

- [개요](#개요)
- [최근 개선 사항](#최근-개선-사항)
- [프로젝트 구조](#프로젝트-구조)
- [실행 구조](#실행-구조)
- [설치 및 초기 설정](#설치-및-초기-설정)
- [명령 실행](#명령-실행)
- [설정](#설정)
- [실행 전 점검](#실행-전-점검)
- [로그 및 결과 확인](#로그-및-결과-확인)
- [문제 해결](#문제-해결)
- [로컬 개발 및 테스트](#로컬-개발-및-테스트)
- [배포](#배포)
- [보안 및 라이선스](#보안-및-라이선스)
- [변경 이력](CHANGELOG.md)

---

## 개요

LLM Wiki Bridge는 터미널에서 실행하던 LLM-Wiki 작업을 Obsidian 명령 팔레트와 리본 아이콘으로 연결합니다.

- **안전 점검**: `wiki-now.sh --safe` 실행
- **전체 정제**: `wiki-now.sh` 실행
- **위키 생성**: `wiki refine-scan`으로 선택한 에이전트에 생성 요청
- **원샷 실행**: 전체 정제 후 위키 생성을 순서대로 실행
- **진행 확인**: 실행 전 확인 모달과 stdout·stderr 진행 로그 제공

정제와 생성 로직은 외부 하네스가 담당합니다. 이 저장소는 Obsidian UI, 실행 환경 구성, 사전 점검, 프로세스 실행과 결과 표시를 관리합니다.

| 항목 | 값 |
| --- | --- |
| 플러그인 ID | `llm-wiki-bridge` |
| manifest 버전 | `0.1.0` |
| 최소 Obsidian 버전 | `1.4.0` |
| 실행 환경 | Obsidian 데스크톱, 로컬 파일시스템, `bash`와 `which`를 사용할 수 있는 환경 |
| 기본 생성 에이전트 | `codex-cli` |

---

## 최근 개선 사항

### 2026-10 · Unreleased

아래 내용은 현재 소스의 미출시 변경입니다. 상세는 [CHANGELOG.md](CHANGELOG.md)를 참조하세요.

- **하네스 경로 정합화**: 기본값을 `~/.ai-harness`로 변경하고 저장된 이전 기본값만 이관합니다.
- **저널 집계 수정**: 주차·날짜 폴더를 읽고 인덱스와 동일 파일명의 복사본을 제외합니다. 읽기 오류는 0건과 구분합니다.
- **명령별 사전 점검**: 위키 생성만 실행할 때는 런처를 요구하지 않으며 선택한 에이전트에 맞춰 검사합니다.
- **실패 결과 보존**: 원샷 첫 단계가 실패하면 두 번째 단계가 성공해도 전체 성공으로 표시하지 않습니다.
- **로그 누적 제한**: 진행 모달에는 최근 256 Ki 문자만 유지합니다.
- **자동 검증 추가**: Node.js 테스트 15개와 GitHub Actions 검사, Dependabot 설정을 추가했습니다.

---

## 프로젝트 구조

```text
llm-wiki-bridge/
├── main.js                    # 플러그인 UI·설정·명령·프로세스 실행
├── manifest.json              # 플러그인 ID·버전·Obsidian 요구사항
├── styles.css                 # 진행 모달과 로그 스타일
├── versions.json              # 플러그인 버전별 최소 Obsidian 버전
├── package.json               # 구문 검사와 테스트 명령
├── tests/
│   └── main.test.js            # 회귀 테스트와 자식 프로세스 검증
├── .github/
│   ├── workflows/test.yml     # push·pull request 검사
│   └── dependabot.yml         # GitHub Actions 업데이트 설정
├── CHANGELOG.md               # 변경 이력
├── SECURITY.md                # 보안 경계와 취약점 제보 안내
└── LICENSE                    # MIT 라이선스
```

`main.js`가 직접 배포 파일입니다. 별도 번들 빌드나 런타임 npm 의존성 설치는 없습니다.

## 실행 구조

| 구성 요소 | 역할 | 연결 대상 |
| --- | --- | --- |
| `LlmWikiBridgePlugin` | 명령 등록, 실행 흐름과 설정 관리 | 확인 모달, 실행기, 진행 모달 |
| `ConfirmRefineModal` | 오늘 저널 수·생성 건수·에이전트 표시와 실행 확인 | 사용자 승인 결과 |
| `HarnessExecutor` | 경로·환경 구성, 사전 점검, 자식 프로세스 실행 | `wiki-now.sh`, `bin/wiki` |
| `ProgressModal` | stdout·stderr 표시와 최종 결과 안내 | 실행 중인 직접 자식 프로세스 |
| `LlmWikiBridgeSettingTab` | 하네스 경로·생성 에이전트·건수·런처 설정 | Obsidian 플러그인 설정 저장소 |

실행기는 명령과 인자를 분리해 `shell: false`로 실행합니다. `wiki-now.sh`는 `bash`로 호출하고, `bin/wiki`는 직접 실행합니다.

| 전달 환경변수 | 값 |
| --- | --- |
| `HARNESS_ROOT` | 설정한 하네스 루트 |
| `VAULT_ROOT` | 현재 Obsidian 볼트의 로컬 경로 |
| `WIKI_BIN` | `<HARNESS_ROOT>/bin/wiki` |
| `WIKI_AGENT` | 선택한 Refine 에이전트 |
| `PATH` | 기존 PATH에 asdf shims·Homebrew·사용자 로컬 bin 경로 보완 |
| `_ZO_DOCTOR` | `0` |

---

## 설치 및 초기 설정

### 사전 요구사항

- Obsidian 데스크톱 `1.4.0` 이상
- 로컬 LLM-Wiki 하네스와 실행 가능한 `bin/wiki`
- 전체 정제·안전 점검·원샷에 사용할 볼트 내부 `wiki-now.sh`
- 위키 생성에 사용할 실행 가능한 `wiki/ingest/refine-<agent>.sh`
- `codex-cli`를 선택했다면 `codex` CLI 설치와 로그인

다른 에이전트의 API 접근이나 자격증명 준비는 해당 하네스의 실행 조건을 따릅니다.

### 수동 설치

1. 대상 볼트에 `.obsidian/plugins/llm-wiki-bridge/` 디렉터리를 만듭니다.
2. 아래 파일을 해당 디렉터리에 복사합니다.

   ```text
   <your-vault>/.obsidian/plugins/llm-wiki-bridge/
   ├── manifest.json
   ├── main.js
   ├── styles.css
   └── versions.json
   ```

3. Obsidian을 다시 열거나 플러그인 목록을 새로고침한 뒤 **LLM Wiki Bridge**를 활성화합니다.
4. 플러그인 설정에서 **Harness 루트**와 **wiki-now.sh 상대 경로**를 확인합니다.
5. **사전 점검 → 테스트**로 전체 실행에 필요한 파일과 에이전트를 점검합니다.
6. 명령 팔레트에서 **③ 정제 안전 점검 (lint+doctor)**을 실행해 진행 로그를 확인합니다.

설정 화면의 사전 점검은 원샷 기준입니다. 위키 생성만 사용할 경우 런처가 없다는 경고가 나와도 해당 생성 명령은 자체 점검 결과에 따라 실행할 수 있습니다.

---

## 명령 실행

명령 팔레트에서 `LLM Wiki Bridge`로 검색합니다.

| 명령 이름 | 실행 내용 | 실행 확인 |
| --- | --- | --- |
| `③ 정제 안전 점검 (lint+doctor)` | `bash <wiki-now.sh> --safe` | 별도 확인 모달 없이 실행 |
| `③ 전체 정제 (export→scan→lint)` | `bash <wiki-now.sh>` | 오늘 저널 수 확인 |
| `③ refine-scan 위키 생성` | `<wiki> refine-scan --limit N --agent AGENT --yes` | 에이전트·생성 건수 확인 |
| `③ 전체 정제 + 위키 생성 (원샷)` | 전체 정제 → 위키 생성 | 저널 수·에이전트·생성 건수 확인 |

리본의 `book-open` 아이콘(**LLM Wiki 원샷**)도 원샷 실행을 시작합니다.

위키 생성 확인 모달에서는 생성 건수를 `1~20`으로 조정할 수 있습니다. 하네스에는 `--yes`가 전달되므로 플러그인의 확인 모달에서 실행 대상을 확인하세요. 생성 과정에는 선택한 에이전트의 LLM 호출 비용이 발생할 수 있습니다.

원샷은 첫 단계가 비정상 종료 코드를 반환해도 두 번째 단계를 시도합니다. 어느 단계든 실패하면 최종 결과는 실패이며, 첫 단계가 실패했다면 그 종료 코드를 보존합니다. 프로세스 시작 예외가 발생하면 다음 단계로 진행하지 않습니다.

## 설정

| 설정 | 기본값 | 설명 |
| --- | --- | --- |
| Harness 루트 | `~/.ai-harness` | 공통 하네스가 설치된 로컬 경로 |
| Refine 에이전트 | `codex-cli` | `refine-<agent>.sh`에서 사용할 에이전트 이름 |
| 기본 위키 생성 건수 | `3` | 기본 생성 요청 건수, 허용 범위 `1~20` |
| wiki-now.sh 상대 경로 | `8000_DEV/8100_Super-Power/8140_llm-wiki-launcher/wiki-now.sh` | 현재 볼트 루트를 기준으로 한 런처 경로 |

저장된 하네스 경로가 이전 기본값 `~/.ai_harness`이면 설정 로드 시 `~/.ai-harness`로 이관합니다. 사용자 지정 경로는 보존합니다. 설정 변경은 500 ms 동안 모아 저장합니다.

### 저널 집계 경로

오늘 날짜의 작업 노트를 다음 위치에서 읽습니다.

```text
0000_JOURNAL/YYYY/MM/
├── Www/YYYY-MM-DD/YYYY-MM-DD-NN-제목.md   # 현재 구조
├── YYYY-MM-DD/YYYY-MM-DD-NN-제목.md       # 기존 날짜 폴더
└── YYYY-MM-DD-NN-제목.md                  # 기존 월별 직속 파일
```

`Www`는 ISO 주차입니다. 날짜는 Obsidian을 실행하는 시스템의 로컬 날짜를 사용합니다. `-00` 인덱스·디렉터리는 제외하며 여러 위치에 같은 파일명이 있으면 한 번만 집계합니다. 이 수치는 확인 모달의 안내용이며 실제 처리 대상은 외부 하네스가 결정합니다.

## 실행 전 점검

| 점검 대상 | 안전 점검·전체 정제 | 위키 생성 | 원샷·설정 화면 테스트 |
| --- | --- | --- | --- |
| `bin/wiki` 파일과 실행권한 | 필요 | 필요 | 필요 |
| `wiki-now.sh` 파일과 읽기 권한 | 필요 | 불필요 | 필요 |
| `wiki/ingest/refine-<agent>.sh` 파일과 실행권한 | 불필요 | 필요 | 필요 |
| `codex` CLI 존재 | 불필요 | `codex-cli` 선택 시 필요 | `codex-cli` 선택 시 필요 |

사전 점검은 파일·권한·CLI 존재를 확인합니다. 로그인 상태나 실제 API 접근 성공 여부는 하네스 실행 과정에서 확인합니다.

---

## 로그 및 결과 확인

- 진행 모달에 stdout과 stderr를 함께 표시합니다.
- 로그는 최근 `256 × 1024` 문자까지만 유지하며 이전 출력은 화면에서 제거합니다.
- 정상 종료는 `✓ 완료`, 실패는 경고 문구와 종료 코드로 표시합니다.
- 저널을 읽지 못한 경우 확인 모달에 **집계 실패**와 오류 메시지를 표시합니다.
- 실행이 끝나면 닫기 버튼이 활성화됩니다. 모달이 닫힐 때 연결된 직접 자식 프로세스가 남아 있으면 종료를 요청합니다. 하위 프로세스 전체 종료는 보장하지 않습니다.

플러그인은 로그 파일을 별도로 저장하지 않습니다. 외부 하네스가 남기는 파일·리포트 위치는 하네스 설정에 따릅니다.

## 문제 해결

| 증상 | 확인할 내용 |
| --- | --- |
| `wiki 파일 없음 또는 실행 불가` | Harness 루트가 맞는지, `bin/wiki`가 파일이고 실행권한이 있는지 확인 |
| `wiki-now.sh 파일 없음 또는 읽기 불가` | 볼트 기준 상대 경로와 파일 읽기 권한 확인 |
| `지원하지 않거나 실행 불가한 에이전트` | 하네스에 해당 `refine-<agent>.sh`가 있고 실행 가능한지 확인 |
| `codex CLI 없음` | Codex 설치와 플러그인에서 사용하는 PATH 확인. 설치 후 로그인도 별도 확인 |
| 저널 `집계 실패` | 표시된 오류 경로가 디렉터리인지, 읽기 권한이 있는지 확인 |
| 저널이 있는데 `0건` | 시스템 날짜와 파일명·주차·날짜 폴더 확인. 인덱스만 있는 경우 0건이 정상 |
| 원샷의 위키 생성은 끝났지만 최종 실패 | 첫 단계의 전체 정제 로그와 종료 코드 확인 |
| 화면에서 이전 로그가 사라짐 | 최근 256 Ki 문자 유지 정책에 따른 동작. 하네스의 별도 로그·리포트 확인 |

---

## 로컬 개발 및 테스트

Node.js 22 이상에서 의존성 설치 없이 실행합니다.

```bash
npm run check
npm test
```

| 검사 | 명령·위치 | 검증 범위 |
| --- | --- | --- |
| JavaScript 구문 | `npm run check` | `main.js` 구문 오류 |
| 회귀·프로세스 테스트 | `npm test` · [tests/main.test.js](tests/main.test.js) | 경로 이관, 저널 집계, 권한·에이전트 점검, 원샷 결과, 로그 상한, 실제 자식 프로세스에 인자·환경 전달 |
| CI | [.github/workflows/test.yml](.github/workflows/test.yml) | push·pull request에서 Node.js 22로 구문 검사와 테스트 |
| 액션 업데이트 | [.github/dependabot.yml](.github/dependabot.yml) | GitHub Actions 의존성 주간 업데이트 설정 |

테스트는 임시 볼트·하네스 파일과 Obsidian API 대역을 사용하며 실제 LLM은 호출하지 않습니다. 현재 로컬 검증은 **15개 테스트 통과**입니다. 실제 Obsidian UI와 설치 환경의 하네스 통합, 원격 CI 실행 결과는 별도 확인이 필요합니다.

## 배포

### 수동 배포

검증 후 설치 디렉터리의 `main.js`, `manifest.json`, `styles.css`, `versions.json`을 교체하고 플러그인을 다시 로드합니다. 업데이트 전 기존 설치 파일을 보관하면 문제 발생 시 이전 파일로 복구할 수 있습니다.

### 릴리스 구성

- 릴리스 태그는 `manifest.json`의 버전과 정확히 일치시킵니다. 예: `0.1.0`.
- GitHub Release에는 `manifest.json`, `main.js`, `styles.css`를 직접 첨부합니다.
- `versions.json`은 플러그인 버전별 최소 Obsidian 버전을 기록합니다.
- 현재 GitHub Actions는 검사만 수행합니다. 자동 릴리스나 볼트 설치를 수행하지 않습니다.

## 보안 및 라이선스

신뢰할 수 있는 로컬 하네스와 런처 경로를 사용하세요. 실행 로그에는 외부 명령이 출력한 내용이 포함되므로 공유 전에 민감 정보를 확인하세요. 실행 경계와 취약점 제보 방법은 [SECURITY.md](SECURITY.md)를 참조하세요.

[MIT License](LICENSE)

---

**최종 업데이트**: 2026-10-21

**manifest 버전**: 0.1.0 · 최신 소스의 미출시 개선은 [CHANGELOG.md](CHANGELOG.md) 참조
