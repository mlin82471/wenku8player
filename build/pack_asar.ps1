$projectDir = "D:\linhr\Documents\wenku8-netease-player"
$staging = "$projectDir\build\asar_staging"

if (Test-Path $staging) {
    Remove-Item $staging -Recurse -Force
}
New-Item -ItemType Directory -Path $staging -Force | Out-Null

Copy-Item "$projectDir\server.js" "$staging\server.js"
Copy-Item "$projectDir\electron-main.js" "$staging\electron-main.js"
Copy-Item "$projectDir\package.json" "$staging\package.json"
Copy-Item "$projectDir\public" "$staging\public" -Recurse

Set-Location $projectDir
npx asar pack $staging "$projectDir\dist\linux-unpacked\resources\app.asar"
Write-Host "APP_ASAR_PACK_COMPLETE"
