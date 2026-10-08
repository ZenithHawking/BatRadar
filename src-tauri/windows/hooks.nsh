; Runs inside Tauri's NSIS installer. Removes the old Electron build of BatRadar
; so users don't end up with two apps, two tray icons and two autostart entries.
; %APPDATA%\batradar (settings, keys, history) is shared and left untouched.

!include FileFunc.nsh

; electron-builder derives this key from appId "com.batradar.app"
!define ELECTRON_UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\a649da01-ba82-577e-8af0-ea8e1ae1be8e"

Var MigratedFromElectron

!macro NSIS_HOOK_PREINSTALL
  StrCpy $MigratedFromElectron 0
  StrCpy $0 "$LOCALAPPDATA\Programs\bat-radar"
  IfFileExists "$0\BatRadar.exe" 0 electron_done
    StrCpy $MigratedFromElectron 1
    DetailPrint "Removing the previous Electron version of BatRadar..."
    ; The Electron app hides its windows instead of closing them, so its
    ; updater's quit request leaves it running and its exe locked. Stop it
    ; first by image name (a running copy of this app would be stopped by the
    ; installer's own check right after anyway), then wait (max 15 s) until
    ; the exe can be renamed.
    nsis_tauri_utils::KillProcessCurrentUser "BatRadar.exe"
    Pop $1
    Sleep 1000
    StrCpy $1 0
    electron_wait:
      ClearErrors
      Rename "$0\BatRadar.exe" "$0\BatRadar.exe.probe"
      IfErrors 0 electron_unlocked
      IntOp $1 $1 + 1
      IntCmp $1 30 electron_unlocked
      Sleep 500
      Goto electron_wait
    electron_unlocked:
    Rename "$0\BatRadar.exe.probe" "$0\BatRadar.exe"
    IfFileExists "$0\Uninstall BatRadar.exe" 0 electron_force
      ; _?= runs the uninstaller in place so ExecWait really waits for it
      ExecWait '"$0\Uninstall BatRadar.exe" /currentuser /S _?=$0'
    electron_force:
    ; Whatever the uninstaller could not remove goes too
    RMDir /r "$0"
    DeleteRegKey HKCU "${ELECTRON_UNINSTALL_KEY}"
    RMDir /r "$LOCALAPPDATA\bat-radar-updater"
  electron_done:
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "com.batradar.app"
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; The Electron build had a desktop shortcut; its uninstaller removed it
  StrCmp $MigratedFromElectron 1 0 shortcut_done
    CreateShortCut "$DESKTOP\BatRadar.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
  shortcut_done:

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
