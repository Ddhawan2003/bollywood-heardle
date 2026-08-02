<#
    Assembles src/template.html into the single self-contained bollywood-heardle.html.

    The shipped game is one file with no external requests, because the Artifact
    CSP blocks every external host - a CDN <script> or a linked webfont would
    simply never load. So React and the display face are inlined here at build
    time rather than referenced.

    Usage:   pwsh build/build.ps1          (from the repo root)
             pwsh build/build.ps1 -Verify  (also runs the test suites)
#>
[CmdletBinding()]
param(
    [switch]$Verify
)

$ErrorActionPreference = 'Stop'

$root     = Split-Path -Parent $PSScriptRoot
$template = Join-Path $root 'src\template.html'
$vendor   = Join-Path $root 'vendor'
# index.html, so that a static host serves the game at the bare URL and a push
# is a deploy. Double-clicking it locally still works exactly the same.
$output   = Join-Path $root 'index.html'

foreach ($f in @($template,
                 (Join-Path $vendor 'react.min.js'),
                 (Join-Path $vendor 'react-dom.min.js'),
                 (Join-Path $vendor 'anton.b64'))) {
    if (-not (Test-Path $f)) { throw "Missing required input: $f" }
}

$html = [IO.File]::ReadAllText($template)

# The diacritic-stripping range is written as literal combining marks in the
# template (they survive editing badly). Rewrite them as explicit \u escapes so
# the shipped file is robust to any encoding round-trip. This is what makes
# "Senorita" match Apple's "Senorita" spelled with a tilde-n.
$pattern     = '\.normalize\("NFD"\)\.replace\(/\[[^\]]*\]/g, ""\)'
$replacement = '.normalize("NFD").replace(/[\u0300-\u036f]/g, "")'
$html = [Text.RegularExpressions.Regex]::Replace($html, $pattern, $replacement)

# Literal .Replace(), never -replace: the minified React source contains '$&'
# and '$1' sequences that PowerShell's regex replacement would eat.
$html = $html.Replace('__ANTON_B64__',    [IO.File]::ReadAllText((Join-Path $vendor 'anton.b64')))
$html = $html.Replace('__REACT_JS__',     [IO.File]::ReadAllText((Join-Path $vendor 'react.min.js')))
$html = $html.Replace('__REACT_DOM_JS__', [IO.File]::ReadAllText((Join-Path $vendor 'react-dom.min.js')))

foreach ($token in @('__ANTON_B64__', '__REACT_JS__', '__REACT_DOM_JS__')) {
    if ($html.Contains($token)) { throw "Placeholder was never substituted: $token" }
}

# A stray closing tag inside the app JS would end that block early and dump raw
# source into the page. Counting '<script' vs '</script' does NOT work here: the
# app deliberately mentions the string "<script>" in a comment explaining the
# JSONP trick. So walk the blocks instead - open a block, jump past its close,
# and never look inside - then assert no unmatched closing tags are left over.
$blocks = 0
$pos    = 0
while ($true) {
    $open = $html.IndexOf('<script', $pos)
    if ($open -lt 0) { break }
    $gt = $html.IndexOf('>', $open)
    if ($gt -lt 0) { throw 'Malformed <script> tag in output.' }
    $close = $html.IndexOf('</script', $gt)
    if ($close -lt 0) { throw "Unclosed <script> block at offset $open." }
    $blocks++
    $pos = $close + 8
}
$closings = [regex]::Matches($html, '</script').Count
if ($closings -ne $blocks) {
    throw "Script block mismatch: $blocks opened, $closings closing tags (a stray </script inside JS?)."
}
Write-Host "scripts  : $blocks blocks, balanced"

# src/template.html is a FRAGMENT on purpose: published as a Claude Artifact it
# is wrapped in a document by the platform, so carrying its own <head> would
# nest one document inside another. A file served over HTTP has no such wrapper,
# and without it there is no viewport meta - which is not cosmetic. Mobile
# Safari assumes a 980px canvas for pages that do not declare one and scales the
# result down, so the template's own `@media (max-width: 420px)` rules never
# match and the phone gets a shrunken desktop layout. The skeleton is therefore
# added here, at the point where the standalone file is produced.
$title = 'Filmi — Guess the Bollywood Song'
$m = [regex]::Match($html, '(?s)<title>(.*?)</title>\s*')
if ($m.Success) {
    $title = $m.Groups[1].Value.Trim()
    $html  = $html.Remove($m.Index, $m.Length)   # re-emitted inside <head>
}

$head = @"
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="dark">
<meta name="description" content="Guess the Hindi film song from a half-second clip.">
<!-- Added to the home screen on iOS this runs chromeless, like an app. -->
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="Filmi">
<title>$title</title>
</head>
<body>
"@

$html = $head + $html + "`n</body>`n</html>`n"

# No UTF-8 BOM: it would be emitted before the doctype and show up as stray glyphs.
[IO.File]::WriteAllText($output, $html, (New-Object Text.UTF8Encoding $false))

$kb    = [Math]::Round((Get-Item $output).Length / 1KB, 1)
$songs = [regex]::Matches($html, 'trackId: \d+').Count
$ext   = [regex]::Matches($html, '(src|href)="https?://').Count

Write-Host "built    : $output"
Write-Host "size     : $kb KB"
Write-Host "songs    : $songs pinned"
Write-Host "external : $ext subresources (must be 0)"

if ($ext -ne 0) { throw "Output is not self-contained: $ext external subresource(s)." }

if ($Verify) {
    Write-Host ''
    node (Join-Path $root 'test\test.js')
    node (Join-Path $root 'test\test-offline.js')
    node (Join-Path $root 'test\test-ui.js')
}
