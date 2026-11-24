@echo off
REM ---------------------------------------------------------------
REM  Debian 12 webterm  -  GitHub verzio (lite)
REM  Ez a kisebb valtozat: csak a gyakori parancsokhoz.
REM ---------------------------------------------------------------
setlocal
cd /d "%~dp0"

echo.
echo  ==========================================
echo   Debian 12 webterm  -  lite (kis meret)
echo  ==========================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo  [!] A Node.js nem talalhato a PATH-ban.
  echo      Telepitsd innen: https://nodejs.org
  echo.
  pause
  exit /b 1
)

echo  Szerver inditasa a 8097-as porton...
start "Debian webterm szerver (lite)" /min cmd /c "node "%~dp0tools\serve.js" 8097"
timeout /t 2 /nobreak >nul
start "" "http://localhost:8097/index.html"

echo  Ha a bongeszo nem nyilt meg, nyisd meg kezzel:
echo      http://localhost:8097/index.html
echo.
echo  A szerver leallitasahoz csukd be a szerver ablakot.
echo.
pause
