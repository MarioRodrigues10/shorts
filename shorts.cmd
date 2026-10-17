@echo off
rem Windows launcher for the `shorts` command (scripts\setup.ps1 puts this folder on your PATH).
"%~dp0.venv\Scripts\python.exe" "%~dp0shorts" %*
