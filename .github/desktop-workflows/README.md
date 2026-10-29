# 보관된 데스크톱 워크플로

이 폴더에는 원본 OpenScreen 프로젝트의 데스크톱 빌드·릴리스·문서 배포·Discord 자동화를 보관합니다. GitHub Actions는 이 폴더의 워크플로를 실행하지 않습니다.

웹 저장소에서는 `.github/workflows/web.yml`로 타입 검사, 웹 테스트, 웹 빌드를 실행하고, Vercel의 GitHub 연동으로 배포합니다. 로컬 Electron 개발·빌드 명령은 계속 사용할 수 있습니다.

데스크톱 자동화를 다시 사용할 경우 저장소 이름, 배포 대상, 권한, secrets와 워크플로 간 경로 참조를 검토한 뒤 필요한 파일만 `.github/workflows/`로 복원하세요.
