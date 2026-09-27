@echo off
rem Builds the Zoon Player release APK into android\dist\Zoon Player.apk.
rem
rem Needs JDK 17+ and the Android SDK (platform 37). If JAVA_HOME / ANDROID_HOME aren't set, it
rem uses a toolchain in %USERPROFILE%\.android-dev (jdk-21, sdk). The release key is read from
rem the file named by the zoon.signing Gradle property, or %USERPROFILE%\.android-dev\keys\zoon-release.properties;
rem without one the APK is signed with the debug key. Keep your key: Android only installs
rem updates signed with the same key.
setlocal
set "DEV=%USERPROFILE%\.android-dev"
if not defined JAVA_HOME if exist "%DEV%\jdk-21" set "JAVA_HOME=%DEV%\jdk-21"
if not defined ANDROID_HOME if exist "%DEV%\sdk" set "ANDROID_HOME=%DEV%\sdk"
if not defined GRADLE_USER_HOME if exist "%DEV%\gradle-home" set "GRADLE_USER_HOME=%DEV%\gradle-home"
cd /d "%~dp0"
call "%~dp0gradlew.bat" :app:distApk %*
if errorlevel 1 exit /b 1
echo Built dist\Zoon Player.apk
