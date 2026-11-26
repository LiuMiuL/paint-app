# 그림판 안드로이드 앱 빌드 (+ 폰 설치)
#   사용법:  powershell -ExecutionPolicy Bypass -File android\build.ps1 [-Install]
#   - 프로젝트 루트의 웹 파일(index.html, app.js, styles.css …)을 APK 안에 넣는다.
#   - Gradle·npm 없이 Android SDK의 aapt2 / d8 / apksigner 와 JDK(javac)만 쓴다.
#   - 결과: android\build\paint-app.apk  (-Install 이면 USB로 연결된 폰에 바로 설치)
param([switch]$Install)
$ErrorActionPreference = 'Stop'

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $here
$out  = Join-Path $here 'build'

# ── 도구 찾기 ─────────────────────────────────────────
$sdk = $env:ANDROID_HOME
if (-not $sdk) { $sdk = $env:ANDROID_SDK_ROOT }
if (-not $sdk) { $sdk = 'D:\Miu\Tools\android-sdk' }
if (-not (Test-Path $sdk)) { throw "Android SDK를 찾을 수 없어요: $sdk (ANDROID_HOME 을 지정하세요)" }
$bt  = Get-ChildItem (Join-Path $sdk 'build-tools') -Directory | Sort-Object { [version]$_.Name } | Select-Object -Last 1
$plt = Get-ChildItem (Join-Path $sdk 'platforms') -Directory | Sort-Object { [int]($_.Name -replace '\D', '') } | Select-Object -Last 1
$androidJar = Join-Path $plt.FullName 'android.jar'
$aapt2 = Join-Path $bt.FullName 'aapt2.exe'
$d8 = Join-Path $bt.FullName 'd8.bat'
$zipalign = Join-Path $bt.FullName 'zipalign.exe'
$apksigner = Join-Path $bt.FullName 'apksigner.bat'
$adb = Join-Path $sdk 'platform-tools\adb.exe'
$javaBin = if ($env:JAVA_HOME) { Join-Path $env:JAVA_HOME 'bin' } else { '' }
$javac = if ($javaBin -and (Test-Path (Join-Path $javaBin 'javac.exe'))) { Join-Path $javaBin 'javac.exe' } else { 'javac' }
$keytool = if ($javaBin -and (Test-Path (Join-Path $javaBin 'keytool.exe'))) { Join-Path $javaBin 'keytool.exe' } else { 'keytool' }

function Run($exe, [string[]]$argList) {
  & $exe @argList
  if ($LASTEXITCODE -ne 0) { throw "실패: $exe $($argList -join ' ')" }
}

# 앱 버전 이름은 sw.js 의 VERSION 을 따른다.
$version = ([regex]::Match((Get-Content (Join-Path $root 'sw.js') -Raw), "VERSION = 'v([^']+)'")).Groups[1].Value
if (-not $version) { $version = '1.0.0' }
# 버전 코드는 빌드할 때마다 커지게 (분 단위)
$versionCode = [int](([DateTime]::UtcNow - [DateTime]'2026-01-01').TotalMinutes)

Write-Host "== 그림판 앱 빌드 v$version ($($bt.Name), $($plt.Name))"

# ── 1. 작업 폴더 준비 ─────────────────────────────────
if (Test-Path $out) { Remove-Item -Recurse -Force $out }
$assets = Join-Path $out 'assets'
$res = Join-Path $out 'res\mipmap'
$classes = Join-Path $out 'classes'
New-Item -ItemType Directory -Force $assets, $res, $classes | Out-Null

# ── 2. 웹 파일을 앱 안으로 복사 ───────────────────────
$web = 'index.html', 'styles.css', 'app.js', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'icon-512-maskable.png'
foreach ($f in $web) { Copy-Item (Join-Path $root $f) $assets }
Copy-Item (Join-Path $root 'icon-192.png') (Join-Path $res 'ic_launcher.png')

# ── 3. 리소스 + 매니페스트 → APK 뼈대 ─────────────────
$resZip = Join-Path $out 'res.zip'
$baseApk = Join-Path $out 'base.apk'
Run $aapt2 @('compile', '--dir', (Join-Path $out 'res'), '-o', $resZip)
Run $aapt2 @('link', '-I', $androidJar, '--manifest', (Join-Path $here 'AndroidManifest.xml'),
  '-A', $assets, '--version-name', $version, '--version-code', "$versionCode", '-o', $baseApk, $resZip)

# ── 4. 자바 → dex ─────────────────────────────────────
$srcs = Get-ChildItem (Join-Path $here 'src') -Recurse -Filter *.java | ForEach-Object { $_.FullName }
Run $javac (@('--release', '11', '-encoding', 'UTF-8', '-nowarn', '-classpath', $androidJar, '-d', $classes) + $srcs)
$classFiles = Get-ChildItem $classes -Recurse -Filter *.class | ForEach-Object { $_.FullName }
Run $d8 (@('--release', '--min-api', '29', '--lib', $androidJar, '--output', $out) + $classFiles)

# classes.dex 를 APK 에 넣기
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::Open($baseApk, 'Update')
try {
  [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, (Join-Path $out 'classes.dex'), 'classes.dex') | Out-Null
} finally { $zip.Dispose() }

# ── 5. 정렬 + 서명 ────────────────────────────────────
# 서명 키는 이 PC에만 둔다(.gitignore). 키가 바뀌면 폰에서 앱을 지우고 다시 설치해야 한다.
$keystore = Join-Path $here 'paint-app.keystore'
if (-not (Test-Path $keystore)) {
  Write-Host '== 서명 키 만들기 (처음 한 번)'
  Run $keytool @('-genkeypair', '-keystore', $keystore, '-alias', 'paint', '-keyalg', 'RSA', '-keysize', '2048',
    '-validity', '10000', '-storepass', 'paintapp', '-keypass', 'paintapp', '-dname', 'CN=Paint App')
}
$aligned = Join-Path $out 'aligned.apk'
$apk = Join-Path $out 'paint-app.apk'
Run $zipalign @('-p', '-f', '4', $baseApk, $aligned)
Run $apksigner @('sign', '--ks', $keystore, '--ks-pass', 'pass:paintapp', '--key-pass', 'pass:paintapp', '--out', $apk, $aligned)
Write-Host "== 완성: $apk"

# ── 6. 폰에 설치 ──────────────────────────────────────
if ($Install) {
  $devices = & $adb devices | Select-String "`tdevice$"
  if (-not $devices) { throw '연결된 폰이 없어요. USB 디버깅을 켜고 USB로 연결하세요.' }
  Write-Host '== 폰에 설치 중…'
  Run $adb @('install', '-r', $apk)
  Run $adb @('shell', 'am', 'start', '-n', 'com.liumiul.paint/.MainActivity')
  Write-Host '== 설치 완료 — 폰에서 그림판 앱이 열렸어요'
}
