<#
    从仓库根目录的 icon.jpg 生成 Android 各分辨率的启动器图标。

    用法（Windows）：
        powershell -ExecutionPolicy Bypass -File tools\make-icons.ps1

    产物（都是构建用静态资源，已提交进仓库，换图标后重跑一次即可）：
        android/app/src/main/res/mipmap-<dpi>/ic_launcher.png           方形(传统)
        android/app/src/main/res/mipmap-<dpi>/ic_launcher_round.png     圆形(传统)
        android/app/src/main/res/mipmap-<dpi>/ic_launcher_foreground.png 自适应前景
#>
param(
    [string]$Source = (Join-Path $PSScriptRoot '..\icon.jpg'),
    [string]$ResDir = (Join-Path $PSScriptRoot '..\android\app\src\main\res')
)

Add-Type -AssemblyName System.Drawing
$ErrorActionPreference = 'Stop'

$Source = (Resolve-Path -LiteralPath $Source).Path
$img = [System.Drawing.Image]::FromFile($Source)

$densities = [ordered]@{ mdpi = 1.0; hdpi = 1.5; xhdpi = 2.0; xxhdpi = 3.0; xxxhdpi = 4.0 }

function Save-Bitmap {
    param([System.Drawing.Bitmap]$Bitmap, [string]$Path)
    $dir = Split-Path -Parent $Path
    if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    $Bitmap.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
    $Bitmap.Dispose()
    Write-Host ("[icon] " + (Resolve-Path -LiteralPath $Path).Path.Replace($ResDir, 'res'))
}

function New-Canvas {
    param([int]$Size)
    $bmp = New-Object System.Drawing.Bitmap $Size, $Size
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
    $g.Clear([System.Drawing.Color]::Transparent)
    return @($bmp, $g)
}

function New-RoundedPath {
    param([single]$W, [single]$H, [single]$R)
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $d = $R * 2
    $path.AddArc(0, 0, $d, $d, 180, 90)
    $path.AddArc(($W - $d), 0, $d, $d, 270, 90)
    $path.AddArc(($W - $d), ($H - $d), $d, $d, 0, 90)
    $path.AddArc(0, ($H - $d), $d, $d, 90, 90)
    $path.CloseFigure()
    return $path
}

foreach ($name in $densities.Keys) {
    $scale = $densities[$name]
    $legacySize = [int](48 * $scale)
    $adaptiveSize = [int](108 * $scale)
    $outDir = Join-Path $ResDir ('mipmap-' + $name)

    # 1) 方形（Android 7 及以下）：圆角方形遮罩，满血铺图
    $pair = New-Canvas $legacySize
    $bmp = $pair[0]; $g = $pair[1]
    $clip = New-RoundedPath $legacySize $legacySize ($legacySize * 0.18)
    $g.SetClip($clip)
    $g.DrawImage($img, 0, 0, $legacySize, $legacySize)
    $g.Dispose(); $clip.Dispose()
    Save-Bitmap $bmp (Join-Path $outDir 'ic_launcher.png')

    # 2) 圆形（Android 7 及以下，圆形启动器）
    $pair = New-Canvas $legacySize
    $bmp = $pair[0]; $g = $pair[1]
    $clip = New-Object System.Drawing.Drawing2D.GraphicsPath
    $clip.AddEllipse(0, 0, $legacySize, $legacySize)
    $g.SetClip($clip)
    $g.DrawImage($img, 0, 0, $legacySize, $legacySize)
    $g.Dispose(); $clip.Dispose()
    Save-Bitmap $bmp (Join-Path $outDir 'ic_launcher_round.png')

    # 3) 自适应图标前景（Android 8+）：108dp 画布，图按 80% 居中，
    #    这样无论厂商用圆形、方形还是水滴遮罩，主体都不会被切掉；
    #    四周用同色暗角糊过去，避免出现方框接缝
    $pair = New-Canvas $adaptiveSize
    $bmp = $pair[0]; $g = $pair[1]
    $bgColor = [System.Drawing.Color]::FromArgb(255, 14, 12, 10)
    $g.Clear($bgColor)
    $inset = [int]($adaptiveSize * 0.10)
    $inner = $adaptiveSize - 2 * $inset
    $g.DrawImage($img, $inset, $inset, $inner, $inner)

    $vignettePath = New-Object System.Drawing.Drawing2D.GraphicsPath
    $vignettePath.AddEllipse(0, 0, $adaptiveSize, $adaptiveSize)
    $vignette = New-Object System.Drawing.Drawing2D.PathGradientBrush $vignettePath
    $vignette.CenterColor = [System.Drawing.Color]::FromArgb(0, 14, 12, 10)
    $vignette.SurroundColors = @([System.Drawing.Color]::FromArgb(255, 14, 12, 10))
    $vignette.FocusScales = New-Object System.Drawing.PointF(0.72, 0.72)
    $g.FillEllipse($vignette, 0, 0, $adaptiveSize, $adaptiveSize)
    $vignette.Dispose(); $vignettePath.Dispose()

    $g.Dispose()
    Save-Bitmap $bmp (Join-Path $outDir 'ic_launcher_foreground.png')
}

$img.Dispose()
Write-Host '[icon] 完成：mipmap-mdpi ~ mipmap-xxxhdpi'
