; Runs inside Tauri's NSIS installer. Removes the old Electron build of BatRadar
; so users don't end up with two apps, two tray icons and two autostart entries.
; %APPDATA%\batradar (settings, keys, history) is shared and left untouched.

!include FileFunc.nsh

!macro NSIS_HOOK_PREINSTALL
  StrCpy $0 "$LOCALAPPDATA\Programs\bat-radar"
  IfFileExists "$0\Uninstall BatRadar.exe" 0 electron_done
    DetailPrint "Removing the previous Electron version of BatRadar..."
    ; _?= runs the uninstaller in place so ExecWait really waits for it
    ExecWait '"$0\Uninstall BatRadar.exe" /currentuser /S _?=$0'
    RMDir /r "$0"
  electron_done:
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "com.batradar.app"
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; electron-updater passes --force-run; when the install was silent there is
  ; no finish page to launch the app from, so start it here
  ${GetParameters} $R0
  ClearErrors
  ${GetOptions} $R0 "--force-run" $R1
  IfErrors postinstall_done
  IfSilent 0 postinstall_done
    Exec '"$INSTDIR\${MAINBINARYNAME}.exe"'
  postinstall_done:
!macroend
