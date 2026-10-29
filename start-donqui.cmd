@echo off
cd /d "%~dp0"
if not exist "node_modules\electron\dist\electron.exe" (
  echo Dependencies are missing. Run npm ci first.
  pause
  exit /b 1
)
node scripts\donqui-ensure-build.cjs
if errorlevel 1 (pause & exit /b 1)
rem Tools that are Electron apps themselves can leave this set; electron.exe would then run
rem as plain Node and open no window.
set ELECTRON_RUN_AS_NODE=
rem "." and not "%~dp0": that path ends in a backslash, which escapes the closing quote, so
rem Electron was handed a folder name ending in a quote and showed an "Error" window.
start "Donqui Studio" "%~dp0node_modules\electron\dist\electron.exe" .
