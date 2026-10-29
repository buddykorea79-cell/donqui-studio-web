# Donqui Studio Web — GitHub / Vercel 배포

실제 실행·내보내기 검사와 미검증 범위는 [웹 검증 기록](WEB-VALIDATION.md)에 정리했습니다.

웹 버전은 별도 설치 없이 브라우저에서 미디어를 불러와 편집하고 내보내는 정적 React 앱입니다. Vercel은 HTML·JavaScript·아이콘을 제공하고, 영상 처리와 저장은 방문자의 브라우저에서 실행합니다. 서버, 데이터베이스, API 키, FFmpeg 설치가 필요하지 않습니다.

기존 Electron 앱은 `npm run dev`, `npm run build`로 계속 실행·빌드합니다. 웹 전용 명령은 `:web` 접미사를 사용하므로 데스크톱용 네이티브 바이너리나 Remotion 렌더링 준비 작업을 실행하지 않습니다.

## 로컬에서 실행

Node.js 22.22.1과 npm 10.9.4를 사용합니다. 이미 의존성을 설치했다면 설치 명령은 생략합니다.

```powershell
npm ci --ignore-scripts
npm run dev:web
```

터미널에 표시된 주소(기본 `http://localhost:5173`)를 엽니다. 최신 데스크톱 Chrome 또는 Edge를 권장합니다. `--ignore-scripts`는 웹에서 필요 없는 Electron 바이너리 다운로드와 설치 훅을 생략합니다. 데스크톱 개발도 할 경우에는 기존 안내대로 `npm ci`로 설치합니다.

배포 결과를 로컬에서 확인하려면 다음을 실행합니다.

```powershell
npm run test:web
npm run build:web
npm run preview:web
```

`dist-web/`이 배포 결과입니다. 파일을 직접 더블클릭하는 `file://` 실행 대신 미리보기 서버의 주소를 사용합니다.

## GitHub 저장소

웹 소스는 [buddykorea79-cell/donqui-studio-web](https://github.com/buddykorea79-cell/donqui-studio-web)의 `main` 브랜치를 사용합니다. Vercel에서 이 저장소를 선택하고 Production Branch를 `main`으로 설정합니다.

```powershell
git clone https://github.com/buddykorea79-cell/donqui-studio-web.git
cd donqui-studio-web
npm ci --ignore-scripts
npm run dev:web
```

후속 변경은 작업 브랜치에서 검증한 뒤 PR로 `main`에 반영합니다. 로컬 버전은 별도 [Donqui-Studio 저장소](https://github.com/buddykorea79-cell/Donqui-Studio.git)에서 내려받을 수 있습니다.

`.gitignore`는 `node_modules`, `dist*`, 네이티브 실행 파일, FFmpeg 다운로드, 로컬 작업 데이터, 환경 변수 파일과 Vercel 로컬 설정을 제외합니다. `git status`에서 개인 촬영 원본이나 자격 증명이 들어 있지 않은지 확인합니다. **소스와 `package-lock.json`은 포함하고, 빌드 결과를 업로드하지 않습니다.**

## Vercel에서 배포

1. Vercel에서 **Add New → Project**를 열고 GitHub 저장소를 Import합니다.
2. Root Directory는 저장소 루트(`.`)로 둡니다. `website/`는 기존 프로젝트의 별도 문서 사이트입니다.
3. Framework Preset은 **Vite**, Node.js Version은 **22.x**로 설정합니다.
4. 다음 값은 루트의 `vercel.json`에 들어 있습니다. 프로젝트에 기존 설정이 있으면 같은 값인지 확인합니다.
5. Deploy를 누르고 완료된 HTTPS 주소를 엽니다.

| 설정 | 값 |
| --- | --- |
| Install Command | `npm ci --ignore-scripts` |
| Build Command | `npm run build:web` |
| Output Directory | `dist-web` |
| Development Command | `npm run dev:web` |
| 환경 변수 | 필요 없음 |

SPA 재접속을 위한 rewrite와 미디어 권한 정책도 설정되어 있습니다. 연결한 Git 브랜치에 변경을 반영하면 Vercel Git 연동으로 다시 빌드할 수 있습니다. [Vercel의 Vite 배포 안내](https://vercel.com/docs/frameworks/frontend/vite)와 [빌드 설정 안내](https://vercel.com/docs/builds/configure-a-build)를 참고하세요.

`.github/workflows/web.yml`은 PR·push·수동 실행에서 앱과 테스트 타입 검사, 웹 테스트, 웹 빌드를 확인합니다. GitHub Actions용 Vercel 토큰은 필요 없습니다. 실제 배포는 Vercel의 GitHub 연동이 담당합니다.

원본 데스크톱 빌드·릴리스·문서 사이트 배포·Discord 자동화는 `.github/desktop-workflows/`에 비활성 상태로 보관합니다. 웹 저장소에서 자동 실행되는 워크플로는 `web.yml`입니다.

## 웹 기능과 데스크톱 기능의 범위

웹 버전은 사진·영상 클립의 순서, 구간, 길이, 기본 효과, 자막과 오디오 배치를 편집하고 브라우저에서 30fps 영상을 만듭니다. 내보내기는 브라우저가 지원하는 코덱을 검사해 MP4(H.264/AAC) 또는 WebM(VP9/VP8 + Opus)을 선택합니다. 지원하지 않는 코덱·파일은 오류를 표시하며 다른 형식이나 브라우저를 사용해야 합니다.

데스크톱의 네이티브 GPU 컴포지터, 로컬 Ollama 장면 분석, Whisper 음성 인식, 전체 Remotion 효과, OS 전체 커서 추적·트레이·전역 단축키는 웹 버전에 포함되지 않습니다. 이 기능을 서비스로 제공하려면 별도의 인증된 처리 서버나 추가 웹 구현이 필요합니다. Vercel 정적 배포만으로 로컬 실행 파일을 실행할 수는 없습니다.

화면 녹화는 HTTPS 배포 또는 `localhost`에서 사용해야 합니다. 공유할 화면과 소리의 제공 여부는 브라우저와 OS의 화면 공유 대화상자가 결정합니다. 별도 마이크·웹캠 녹화는 아직 지원하지 않습니다. 영상 처리 중에는 브라우저 탭을 열어 두고, 긴 고해상도 영상은 기기의 메모리·인코딩 성능에 맞춰 사용합니다.

웹에서 선택한 파일을 서버로 업로드하는 API는 없습니다. 타임라인과 원본 미디어를 함께 IndexedDB에 저장하므로 같은 브라우저·주소에서 새로고침해도 작업을 복원할 수 있습니다. 저장 공간이 부족하거나 브라우저가 사이트 데이터를 정리하면 저장되지 않거나 작업이 사라질 수 있으며, 다른 사용자·기기와 자동 동기화하지 않습니다.

**백업 저장**으로 받는 `.donqui` 파일은 타임라인과 원본 미디어를 모두 포함합니다. 다른 기기에서는 **백업 열기**로 이어서 작업할 수 있습니다. 웹 전용 백업 형식이며 기존 Electron 프로젝트 형식과 호환되지 않습니다. 시크릿 창을 닫거나 사이트 데이터를 삭제하기 전에 필요한 작업을 백업합니다.

## 파일 구조

| 파일 | 역할 |
| --- | --- |
| `src/web/` | 브라우저 앱, 저장·미디어 처리 코드 |
| `vite.web.config.ts` | Electron 없는 웹 번들, 웹 진입점 전환 |
| `tsconfig.web.json` | 웹 소스 타입 검사 |
| `public-web/` | 웹에서 제공할 공개 에셋 |
| `vercel.json` | 설치·빌드·출력·라우팅 설정 |
| `.vercelignore` | Vercel CLI 업로드 제외 목록 |
| `.github/workflows/web.yml` | GitHub 웹 검증 작업 |

`vite.web.config.ts`가 `index.html`의 엔트리만 `src/web/main.tsx`로 바꿉니다. 원래 `src/main.tsx`와 Electron 빌드는 그대로 유지됩니다. 웹에서 필요한 공개 파일은 `public-web/`에 추가하고, 개인 영상이나 비밀 값은 넣지 않습니다. `VITE_*` 환경 변수는 브라우저 번들에 노출되므로 비밀 키를 넣는 용도로 사용하지 않습니다.
