@echo off
REM missile-studio server launcher for Windows Task Scheduler (S4U, at startup).
REM ASCII ONLY: cmd.exe reads .cmd files in the ANSI codepage.
REM Edit the three lines below for your machine, or set the same names as user environment variables.
setlocal
if "%MISSILE_HOME%"=="" set MISSILE_HOME=%USERPROFILE%\.missile-studio
if "%MISSILE_HOST%"=="" set MISSILE_HOST=127.0.0.1
if "%MISSILE_PORT%"=="" set MISSILE_PORT=7700
if "%MISSILE_EXE%"=="" set MISSILE_EXE=missile
set PYTHONUTF8=1
if not exist "%MISSILE_HOME%\logs" mkdir "%MISSILE_HOME%\logs"
"%MISSILE_EXE%" serve --host %MISSILE_HOST% --port %MISSILE_PORT% >> "%MISSILE_HOME%\logs\serve.log" 2>&1
