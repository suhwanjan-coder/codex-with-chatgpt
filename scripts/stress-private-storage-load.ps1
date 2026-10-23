$ErrorActionPreference = 'Stop'
$timer = [System.Diagnostics.Stopwatch]::StartNew()
while ($timer.ElapsedMilliseconds -lt 500) {
  for ($i = 1; $i -le 10000; $i++) { $null = [Math]::Sqrt($i) }
}
