param([int]$TaskProcessId,[string]$Root,[string]$OutputPath)
$ErrorActionPreference='Stop'
$seen=@{}
$started=[DateTime]::UtcNow
$exitedAt=$null
while($true){
  $all=@(Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe' OR Name='XwX Deck.exe'")
  $owned=[System.Collections.Generic.HashSet[int]]::new()
  [void]$owned.Add($TaskProcessId)
  do {
    $added=$false
    foreach($item in $all){if($owned.Contains([int]$item.ParentProcessId) -and $owned.Add([int]$item.ProcessId)){$added=$true}}
  } while($added)
  $rows=@()
  foreach($item in $all){
    $key=[string]$item.ProcessId+':'+$item.CreationDate.ToUniversalTime().Ticks
    if(!$owned.Contains([int]$item.ProcessId) -and !$seen.ContainsKey($key)){continue}
    $process=Get-Process -Id $item.ProcessId -ErrorAction SilentlyContinue
    if(!$process){continue}
    $kind=if([int]$item.ProcessId -eq $TaskProcessId){'native'}elseif($item.CommandLine -match '--type=gpu-process'){'gpu'}elseif($item.CommandLine -match '--type=renderer'){'renderer'}elseif($item.CommandLine -match '--type=utility'){'utility'}else{'browser'}
    $row=@{pid=[int]$item.ProcessId;parent=[int]$item.ParentProcessId;kind=$kind;native=([int]$item.ProcessId -eq $TaskProcessId);privateBytes=[long]$process.PrivateMemorySize64;workingBytes=[long]$process.WorkingSet64;handles=$process.HandleCount;threads=$process.Threads.Count;cpuSeconds=$process.TotalProcessorTime.TotalSeconds}
    $rows+=,$row
    $seen[$key]=$row
  }
  $phase='startup'
  try {$progress=Get-Content -LiteralPath (Join-Path $Root 'native-smoke-progress.json') -Raw | ConvertFrom-Json;$phase=$progress.pending} catch {}
  $sum=@{privateBytes=0L;workingBytes=0L;handles=0;threads=0;cpuSeconds=0.0}
  foreach($row in $rows){foreach($field in @('privateBytes','workingBytes','handles','threads')){$sum[$field]+=$row[$field]}}
  foreach($entry in $seen.Values){$sum.cpuSeconds+=$entry.cpuSeconds}
  $now=[DateTime]::UtcNow
  $sample=@{at=$now.ToString('o');elapsedSeconds=($now-$started).TotalSeconds;phase=$phase;tree=$sum;processes=$rows}
  Add-Content -LiteralPath $OutputPath -Value ($sample|ConvertTo-Json -Depth 8 -Compress) -Encoding utf8
  if(!($rows | Where-Object native)){
    if(!$exitedAt){$exitedAt=$now}
    if(($now-$exitedAt).TotalSeconds -ge 15){break}
  } else {$exitedAt=$null}
  Start-Sleep -Seconds 5
}
