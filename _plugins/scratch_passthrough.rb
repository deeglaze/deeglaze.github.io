# Publish scratch/ verbatim at /scratch/.
#
# Jekyll already copies front-matter-free files as static files, but the
# minifier/terser plugins rewrite any .js (and could rewrite .css/.html) on the
# way. Copy the source tree over the output after all other plugins have
# written, so the published files are byte-identical to the ones in scratch/.
require "fileutils"

Jekyll::Hooks.register :site, :post_write do |site|
  src = File.join(site.source, "scratch")
  next unless Dir.exist?(src)

  dest = File.join(site.dest, "scratch")
  FileUtils.mkdir_p(dest)
  FileUtils.cp_r(File.join(src, "."), dest)
end
