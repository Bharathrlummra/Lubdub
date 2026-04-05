[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Ssid,
    [Parameter(Mandatory = $true)][string]$Passphrase
)

$ErrorActionPreference = "Stop"
$netsh = "C:\Windows\System32\netsh.exe"
$profilePath = Join-Path $env:TEMP ("lubdub-" + [Guid]::NewGuid().ToString() + ".xml")

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

    Start-Sleep -Seconds 5

    @{
        success   = $true
        message   = $connectOutput.Trim()
        connected = (& $netsh wlan show interfaces | Out-String).Trim()
    } | ConvertTo-Json -Depth 4
}
finally {
    Remove-Item -LiteralPath $profilePath -Force -ErrorAction SilentlyContinue
}
