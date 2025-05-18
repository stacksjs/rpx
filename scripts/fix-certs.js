#!/usr/bin/env bun

/**
 * RPX Certificate Trust Helper
 * This script automates the process of trusting certificates for the RPX tool.
 * Run with: bun scripts/fix-certs.js
 */

import { execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Colors for terminal output
const colors = {
  reset: '\x1B[0m',
  red: '\x1B[31m',
  green: '\x1B[32m',
  yellow: '\x1B[33m',
  blue: '\x1B[34m',
  cyan: '\x1B[36m',
  bold: '\x1B[1m',
}

console.log(`${colors.blue}${colors.bold}===== RPX Certificate Trust Helper =====${colors.reset}`)
console.log(`${colors.cyan}This utility will help you trust the RPX development certificates${colors.reset}`)

// Find SSL directory and certificates
const sslDir = path.join(os.homedir(), '.stacks', 'ssl')

if (!fs.existsSync(sslDir)) {
  console.error(`${colors.red}Error: SSL directory not found at ${sslDir}${colors.reset}`)
  console.error(`${colors.yellow}Have you run 'rpx start' at least once to generate certificates?${colors.reset}`)
  process.exit(1)
}

// Find all certificate files
const files = fs.readdirSync(sslDir)
const caCerts = files.filter(file => file.endsWith('.ca.crt'))
const serverCerts = files.filter(file => file.endsWith('.crt') && !file.endsWith('.ca.crt'))

if (caCerts.length === 0 && serverCerts.length === 0) {
  console.error(`${colors.red}No certificates found in ${sslDir}${colors.reset}`)
  console.error(`${colors.yellow}Please run 'rpx start' first to generate certificates${colors.reset}`)
  process.exit(1)
}

console.log(`${colors.green}Found these certificates:${colors.reset}`)
console.log(`${colors.blue}CA Certificates:${colors.reset}`)
caCerts.forEach(cert => console.log(`- ${colors.green}${cert}${colors.reset}`))
console.log(`${colors.blue}Server Certificates:${colors.reset}`)
serverCerts.forEach(cert => console.log(`- ${colors.green}${cert}${colors.reset}`))

// Trust certificates based on platform
const platform = os.platform()
console.log(`\n${colors.blue}${colors.bold}Trusting certificates on ${platform}...${colors.reset}`)

try {
  if (platform === 'darwin') {
    // macOS
    console.log(`${colors.yellow}This may prompt for your password...${colors.reset}`)

    // Trust CA certificates
    for (const cert of caCerts) {
      const certPath = path.join(sslDir, cert)
      console.log(`${colors.blue}Trusting CA certificate: ${cert}${colors.reset}`)

      try {
        // Add to system keychain (requires sudo)
        execSync(`sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain "${certPath}"`, { stdio: 'inherit' })

        // Also add to login keychain (doesn't require sudo)
        execSync(`security add-trusted-cert -d -r trustRoot -k ~/Library/Keychains/login.keychain-db "${certPath}"`)

        console.log(`${colors.green}Successfully trusted CA certificate: ${cert}${colors.reset}`)
      }
      catch (error) {
        console.error(`${colors.red}Failed to trust CA certificate: ${cert}${colors.reset}`)
        console.error(error.message)
      }
    }

    // Trust server certificates in login keychain
    for (const cert of serverCerts) {
      const certPath = path.join(sslDir, cert)
      console.log(`${colors.blue}Trusting server certificate: ${cert}${colors.reset}`)

      try {
        execSync(`security add-trusted-cert -d -r trustRoot -k ~/Library/Keychains/login.keychain-db "${certPath}"`)
        console.log(`${colors.green}Successfully trusted server certificate: ${cert}${colors.reset}`)
      }
      catch (error) {
        console.error(`${colors.red}Failed to trust server certificate: ${cert}${colors.reset}`)
      }
    }
  }
  else if (platform === 'linux') {
    // Linux
    console.log(`${colors.yellow}This may prompt for your password...${colors.reset}`)

    // Create a directory for our certificates
    const certDir = '/usr/local/share/ca-certificates/rpx'
    execSync(`sudo mkdir -p "${certDir}"`)

    // Copy all certificates
    for (const cert of [...caCerts, ...serverCerts]) {
      const certPath = path.join(sslDir, cert)
      console.log(`${colors.blue}Installing certificate: ${cert}${colors.reset}`)
      execSync(`sudo cp "${certPath}" "${certDir}/"`, { stdio: 'inherit' })
    }

    // Update CA certificates
    console.log(`${colors.blue}Updating CA certificates...${colors.reset}`)
    execSync('sudo update-ca-certificates', { stdio: 'inherit' })

    console.log(`${colors.green}Successfully installed certificates${colors.reset}`)
  }
  else if (platform === 'win32') {
    // Windows
    console.log(`${colors.yellow}This requires administrator privileges...${colors.reset}`)

    for (const cert of caCerts) {
      const certPath = path.join(sslDir, cert)
      console.log(`${colors.blue}Trusting CA certificate: ${cert}${colors.reset}`)

      // Create a PowerShell script
      const psScript = `
$cert = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2("${certPath.replace(/\\/g, '\\\\')}")
$store = New-Object System.Security.Cryptography.X509Certificates.X509Store("ROOT", "LocalMachine")
$store.Open("ReadWrite")
$store.Add($cert)
$store.Close()
Write-Host "Certificate trusted successfully!"
`

      const psPath = path.join(os.tmpdir(), 'rpx-trust.ps1')
      fs.writeFileSync(psPath, psScript)

      try {
        execSync(`powershell -ExecutionPolicy Bypass -File "${psPath}"`, { stdio: 'inherit' })
        console.log(`${colors.green}Successfully trusted CA certificate: ${cert}${colors.reset}`)
      }
      catch (error) {
        console.error(`${colors.red}Failed to trust CA certificate: ${cert}${colors.reset}`)
        console.error(error.message)
      }

      // Clean up
      try { fs.unlinkSync(psPath) }
      catch (e) { /* ignore */ }
    }
  }
  else {
    console.log(`${colors.red}Automatic certificate trust is not supported on ${platform}${colors.reset}`)
    console.log(`${colors.yellow}Please manually trust the certificates in ${sslDir}${colors.reset}`)
  }

  console.log(`\n${colors.blue}${colors.bold}===== Browser Instructions =====${colors.reset}`)
  console.log(`${colors.yellow}After trusting certificates:${colors.reset}`)
  console.log(`1. ${colors.green}Restart all browser instances${colors.reset}`)
  console.log(`2. If you still see warnings in Chrome/Edge/Arc, type ${colors.green}thisisunsafe${colors.reset} on the warning page`)
  console.log(`   (you won't see what you're typing, but it will bypass the warning)`)

  console.log(`\n${colors.green}${colors.bold}Certificate trust process completed!${colors.reset}`)
}
catch (error) {
  console.error(`${colors.red}Error: ${error.message}${colors.reset}`)
  process.exit(1)
}
