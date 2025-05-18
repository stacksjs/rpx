class Rpx < Formula
  desc "A modern and smart reverse proxy."
  homepage "https://github.com/stacksjs/rpx"
  version "{{ version }}"

  on_macos do
    if Hardware::CPU.arm?
      url "{{ rpx-darwin-arm64.zip_url }}"
      sha256 "UPDATE_WITH_ACTUAL_SHA_AFTER_RELEASE"
    else
      url "{{ rpx-darwin-x64.zip_url }}"
      sha256 "UPDATE_WITH_ACTUAL_SHA_AFTER_RELEASE"
    end
  end

  on_linux do
    if Hardware::CPU.arm?
      url "{{ rpx-linux-arm64.zip_url }}"
      sha256 "UPDATE_WITH_ACTUAL_SHA_AFTER_RELEASE"
    else
      url "{{ rpx-linux-x64.zip_url }}"
      sha256 "UPDATE_WITH_ACTUAL_SHA_AFTER_RELEASE"
    end
  end

  def install
    bin.install "rpx"
  end

  test do
    system "#{bin}/rpx", "--version"
  end
end