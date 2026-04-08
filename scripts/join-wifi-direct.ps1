[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Ssid,
    [Parameter(Mandatory = $true)][string]$Passphrase
)

$ErrorActionPreference = "Stop"
$netsh = "C:\Windows\System32\netsh.exe"
$profilePath = Join-Path $env:TEMP ("lubdub-" + [Guid]::NewGuid().ToString() + ".xml")

function Get-CurrentSsid {
    $interfacesOutput = & $netsh wlan show interfaces | Out-String
    $ssidLine = $interfacesOutput -split "`r?`n" | Where-Object { $_ -match '^\s*SSID\s*:\s*(.+)$' } | Select-Object -First 1
    $currentSsid = $null

    if ($ssidLine -and $ssidLine -match '^\s*SSID\s*:\s*(.+)$') {
        $currentSsid = $Matches[1].Trim()
    }

    return @{
        Ssid = $currentSsid
        Interfaces = $interfacesOutput.Trim()
    }
}

$profileXml = @"
<?xml version="1.0"?>
<WLANProfile xmlns="http://www.microsoft.com/networking/WLAN/profile/v1">
    <name>$Ssid</name>
    <SSIDConfig>
        <SSID>
            <name>$Ssid</name>
        </SSID>
    </SSIDConfig>
    <connectionType>ESS</connectionType>
    <connectionMode>manual</connectionMode>
    <MSM>
        <security>
            <authEncryption>
                <authentication>WPA2PSK</authentication>
                <encryption>AES</encryption>
                <useOneX>false</useOneX>
            </authEncryption>
            <sharedKey>
                <keyType>passPhrase</keyType>
                <protected>false</protected>
                <keyMaterial>$Passphrase</keyMaterial>
            </sharedKey>
        </security>
    </MSM>
</WLANProfile>
"@

try {
    Set-Content -LiteralPath $profilePath -Value $profileXml -Encoding UTF8

    & $netsh wlan add profile filename="$profilePath" user=current | Out-Null
    $connectOutput = & $netsh wlan connect name="$Ssid" ssid="$Ssid" | Out-String
    $deadline = (Get-Date).AddSeconds(20)
    $connectedState = $null

    do {
        Start-Sleep -Seconds 1
        $connectedState = Get-CurrentSsid
        if ($connectedState.Ssid -eq $Ssid) {
            break
        }
    } while ((Get-Date) -lt $deadline)

    if ($connectedState.Ssid -ne $Ssid) {
        $actualSsid = if ($connectedState.Ssid) { $connectedState.Ssid } else { "<none>" }
        throw "Wi-Fi Direct join failed. Expected SSID '$Ssid' but connected SSID is '$actualSsid'."
    }

    @{
        success   = $true
        message   = $connectOutput.Trim()
        connected = $connectedState.Interfaces
        ssid      = $connectedState.Ssid
    } | ConvertTo-Json -Depth 4
}
finally {
    Remove-Item -LiteralPath $profilePath -Force -ErrorAction SilentlyContinue
}
