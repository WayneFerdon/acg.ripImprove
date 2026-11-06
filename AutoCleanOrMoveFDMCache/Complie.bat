@REM kill task in case to delete previous build
taskkill /IM AutoCleanOrMoveFDMCache.exe /F

@REM build and copy dependents
pyinstaller -F --hidden-import queue ./AutoCleanOrMoveFDMCache.pyw
xcopy .\dist\AutoCleanOrMoveFDMCache.exe .\ /y

@REM run the freshly built exe (non-blocking)
start "" ".\AutoCleanOrMoveFDMCache.exe"

@REM delete temp
del .\AutoCleanOrMoveFDMCache.spec /f /s /q 
rd /s /q .\Scripts\__pycache__
rd /s /q .\build
rd /s /q .\dist
pause
