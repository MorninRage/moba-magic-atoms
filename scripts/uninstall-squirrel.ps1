# Uninstall Squirrel-installed IDLE-CRAFT (per-user). Close the game first.
$update = Join-Path $env:LOCALAPPDATA "idlecraft\Update.exe"
if (Test-Path -LiteralPath $update) {
  Write-Host "Running Squirrel uninstall: $update"
  & $update --uninstall
} else {
  Write-Host "Not found: $update (already uninstalled or never installed?)"
  exit 1
}
