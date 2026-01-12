$path = "e:\iot-nexus-core\components\ProtocolAudit.tsx"
$lines = Get-Content $path
$newLines = $lines[0..2236] + $lines[3318..($lines.Count-1)]
$newLines | Set-Content $path -Encoding UTF8
