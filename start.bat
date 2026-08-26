@echo off
title Nathan
cd /d "%~dp0"
set PORT=4173

where node >NUL 2>&1
if %errorlevel%==0 goto usenode
where python >NUL 2>&1
if %errorlevel%==0 goto usepython
goto nothing

:usenode
echo Serving Nathan at http://localhost:%PORT%
echo Close this window to stop.
start "" http://localhost:%PORT%
npx --yes serve -l %PORT% .
goto done

:usepython
echo Serving Nathan at http://localhost:%PORT%
echo Close this window to stop.
start "" http://localhost:%PORT%
python -m http.server %PORT%
goto done

:nothing
echo.
echo Neither Node nor Python was found on this PC.
echo Nathan needs one of them to serve the page on localhost,
echo which the microphone requires.
echo.
echo Install Node from https://nodejs.org then run this file again.
echo.
pause

:done