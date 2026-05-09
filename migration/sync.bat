@echo off
REM Hourly v1->v2 sync runner. Schedule via Windows Task Scheduler.
REM
REM Setup once:
REM   1. Open Task Scheduler -> Create Basic Task
REM   2. Trigger: Daily, repeat every 1 hour for 24 hours
REM   3. Action: Start a program
REM      Program/script:  a:\Projects\wurxos-v2\migration\sync.bat
REM      Start in:        a:\Projects\wurxos-v2\migration
REM   4. (Optional) Settings: "Run task as soon as possible after a
REM      scheduled start is missed"
REM
REM Logs are appended to logs/cron-YYYY-MM-DD.log

setlocal
cd /d "%~dp0"

REM Use the same Node that the project uses. Adjust if needed.
set NODE_BIN=node

REM Daily log file (one per day, lines accumulate)
for /f "tokens=2 delims==" %%a in ('wmic OS Get localdatetime /value') do set DT=%%a
set LOGSTAMP=%DT:~0,4%-%DT:~4,2%-%DT:~6,2%
set LOGFILE=logs\cron-%LOGSTAMP%.log

if not exist logs mkdir logs

echo. >> "%LOGFILE%"
echo ====================================================== >> "%LOGFILE%"
echo Sync run started: %date% %time% >> "%LOGFILE%"
echo ====================================================== >> "%LOGFILE%"

%NODE_BIN% sync-all.js --apply >> "%LOGFILE%" 2>&1

echo. >> "%LOGFILE%"
echo Sync run finished: %date% %time% >> "%LOGFILE%"
endlocal
