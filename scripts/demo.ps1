$ErrorActionPreference = "Stop"

Write-Host "== 4/13 ==" -ForegroundColor Cyan
node dist/src/cli.js run 4 13

Write-Host "`n== 2/3 ==" -ForegroundColor Cyan
node dist/src/cli.js run 2 3

Write-Host "`n== 2/6 (normalizes to 1/3) ==" -ForegroundColor Cyan
node dist/src/cli.js run 2 6

Write-Host "`n== 4/13 with maxTerms=1 (incomplete with remainder) ==" -ForegroundColor Cyan
node dist/src/cli.js run 4 13 --max-terms 1

Write-Host "`n== Invalid input 2/2 (expected failure) ==" -ForegroundColor Yellow
node dist/src/cli.js run 2 2
if ($LASTEXITCODE -eq 0) {
  throw "Invalid input unexpectedly succeeded"
}
exit 0
