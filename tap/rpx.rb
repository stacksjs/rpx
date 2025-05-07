class Rpx < Formula
  desc "A modern and smart reverse proxy for local development"
  homepage "https://github.com/stacksjs/rpx"
  version "0.10.0"
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
