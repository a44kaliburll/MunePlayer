@echo off
rem Builds zunewpd.exe with the Visual Studio 2019 Build Tools (static CRT, no redistributable needed).
setlocal
set VCVARS=C:\Program Files (x86)\Microsoft Visual Studio\2019\BuildTools\VC\Auxiliary\Build\vcvars64.bat
if not exist "%VCVARS%" (
  echo Visual Studio Build Tools not found at "%VCVARS%"
  exit /b 1
)
call "%VCVARS%" >nul || exit /b 1
cd /d "%~dp0"
cl /nologo /EHsc /O2 /W3 /MT /std:c++17 /utf-8 /DUNICODE /D_UNICODE zunewpd.cpp /Fe:zunewpd.exe /link PortableDeviceGUIDs.lib ole32.lib oleaut32.lib || exit /b 1
del /q zunewpd.obj 2>nul
echo built %~dp0zunewpd.exe
