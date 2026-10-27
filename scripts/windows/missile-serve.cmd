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
set LOG=%MISSILE_HOME%\logs\serve.log
:run
REM keep the log small: past 10 MB it becomes serve.log.1 (replacing the one before)
if exist "%LOG%" for %%A in ("%LOG%") do if %%~zA GTR 10485760 move /y "%LOG%" "%LOG%.1" >nul
"%MISSILE_EXE%" serve --host %MISSILE_HOST% --port %MISSILE_PORT% >> "%LOG%" 2>&1
REM the server stopped (a crash, or it was killed for an update): start it again after 10 seconds.
REM Stopping the scheduled task ends this loop. ping is the delay because timeout needs a console.
echo [%date% %time%] server exited with code %errorlevel%, starting again in 10 seconds >> "%LOG%"
ping -n 11 127.0.0.1 >nul
goto run
