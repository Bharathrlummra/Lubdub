[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Ssid,
    [Parameter(Mandatory = $true)][string]$Passphrase,
    [Parameter(Mandatory = $true)][string]$StatusFile,
    [Parameter(Mandatory = $true)][string]$StopFile
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Runtime.WindowsRuntime

function Write-Status {
    param(
        [string]$State,
        [string]$Message
    )

    $payload = @{
        status    = $State
        message   = $Message
        ssid      = $Ssid
        updatedAt = (Get-Date).ToString("o")
    }

    $json = $payload | ConvertTo-Json -Depth 4
    [System.IO.File]::WriteAllText($StatusFile, $json, [System.Text.UTF8Encoding]::new($false))
}

try {
    Remove-Item -LiteralPath $StopFile -Force -ErrorAction SilentlyContinue

    $publisherType = [Windows.Devices.WiFiDirect.WiFiDirectAdvertisementPublisher, Windows, ContentType = WindowsRuntime]
    $credentialType = [Windows.Security.Credentials.PasswordCredential, Windows, ContentType = WindowsRuntime]

    $publisher = [System.Activator]::CreateInstance($publisherType)
    $credential = [System.Activator]::CreateInstance($credentialType)
    $credential.Password = $Passphrase

    $publisher.Advertisement.IsAutonomousGroupOwnerEnabled = $true
    $publisher.Advertisement.LegacySettings.IsEnabled = $true
    $publisher.Advertisement.LegacySettings.Ssid = $Ssid
    $publisher.Advertisement.LegacySettings.Passphrase = $credential
    $publisher.Start()

    Start-Sleep -Milliseconds 800
    Write-Status -State $publisher.Status.ToString() -Message "Wi-Fi Direct legacy session is active."

    while (-not (Test-Path -LiteralPath $StopFile)) {
        Start-Sleep -Seconds 1
    }

    $publisher.Stop()
    Write-Status -State "Stopped" -Message "Wi-Fi Direct session has been stopped."
}
catch {
    Write-Status -State "Error" -Message $_.Exception.Message
    throw
}
finally {
    Remove-Item -LiteralPath $StopFile -Force -ErrorAction SilentlyContinue
}
