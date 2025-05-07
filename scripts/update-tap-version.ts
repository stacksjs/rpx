import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

// Get the package.json version
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const packageJsonPath = path.resolve(__dirname, '..', 'package.json')
const tapFilePath = path.resolve(__dirname, '..', 'tap', 'rpx.rb')

// Ensure tap directory exists
const tapDir = path.resolve(__dirname, '..', 'tap')
if (!fs.existsSync(tapDir))
  fs.mkdirSync(tapDir, { recursive: true })

async function main() {
  try {
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'))
    const newVersion = packageJson.version

    console.log(`Updating tap/rpx.rb to version ${newVersion}`)

    // Check if rpx.rb exists
    if (!fs.existsSync(tapFilePath)) {
      // Create a basic template if it doesn't exist
      const template = getTemplate(newVersion)
      fs.writeFileSync(tapFilePath, template, 'utf8')
      console.log('Created new tap/rpx.rb file')
      return
    }

    // Update the version in the existing file
    let content = fs.readFileSync(tapFilePath, 'utf8')

    // Update version line
    content = content.replace(
      /version\s+["'](.+?)["']/,
      `version "${newVersion}"`,
    )

    fs.writeFileSync(tapFilePath, content, 'utf8')
    console.log('Updated tap/rpx.rb file successfully')
  }
  catch (error) {
    console.error('Error updating tap/rpx.rb:', error)
    process.exit(1)
  }
}

// Template for creating a new rpx.rb file if it doesn't exist
function getTemplate(version: string) {
  return `class Rpx < Formula
  desc "A modern and smart reverse proxy for local development"
  homepage "https://github.com/stacksjs/rpx"
  version "${version}"
  license "MIT"

  on_macos do
    if Hardware::CPU.arm?
      url "https://github.com/stacksjs/rpx/releases/download/v#{version}/rpx-darwin-arm64.zip"
      sha256 "PLACEHOLDER" # darwin-arm64
    else
      url "https://github.com/stacksjs/rpx/releases/download/v#{version}/rpx-darwin-x64.zip"
      sha256 "PLACEHOLDER" # darwin-x64
    end
  end

  on_linux do
    if Hardware::CPU.arm?
      url "https://github.com/stacksjs/rpx/releases/download/v#{version}/rpx-linux-arm64.zip"
      sha256 "PLACEHOLDER" # linux-arm64
    else
      url "https://github.com/stacksjs/rpx/releases/download/v#{version}/rpx-linux-x64.zip"
      sha256 "PLACEHOLDER" # linux-x64
    end
  end

  depends_on "unzip" => :build

  def install
    binary_name = Hardware::CPU.arm? ?
      (OS.mac? ? "rpx-darwin-arm64" : "rpx-linux-arm64") :
      (OS.mac? ? "rpx-darwin-x64" : "rpx-linux-x64")

    # Extract the zip file
    system "unzip", "-o", "#{binary_name}.zip"

    # Install the binary
    bin.install binary_name => "rpx"

    # Create symlink for 'reverse-proxy' command
    bin.install_symlink "rpx" => "reverse-proxy"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/rpx --version")
  end
end
`
}

main().catch(console.error)
