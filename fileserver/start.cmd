@echo off
rem Chay may chu tep NOIBO, ghi log vao logs\server.log (Task Scheduler goi file nay khi khoi dong may)
cd /d "%~dp0"
if not exist logs mkdir logs
node server.js >> logs\server.log 2>&1
