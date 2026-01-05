#!/usr/bin/env ruby
# frozen_string_literal: true

# Fix duplicate attachments in Notion export:
# 1. Find duplicates by SHA256 hash
# 2. Update references in .md files to point to the master (oldest) copy
# 3. Delete duplicates (move to trash)
#
# Usage: ruby fix-duplicates.rb [directory] [--yes]
#        Default directory: ./notion
#        --yes: Skip confirmation prompt

require 'digest'
require 'fileutils'

class NotionDuplicateFixer
  MIN_SIZE_KB = 64 # Only check files larger than this

  def initialize(base_dir, auto_confirm: false)
    @base_dir = File.expand_path(base_dir)
    @auto_confirm = auto_confirm
    @attachments_dir = File.join(@base_dir, 'attachments')
    @filesizes = {}
    @digests = {}
    @duplicates = [] # Array of [delete_path, keep_path]
  end

  def run
    puts "=== Notion Duplicate Fixer ==="
    puts "Directory: #{@base_dir}"
    puts ""

    unless Dir.exist?(@attachments_dir)
      puts "Error: Attachments directory not found: #{@attachments_dir}"
      exit 1
    end

    find_duplicates
    return if @duplicates.empty?

    show_duplicates
    return unless confirm_proceed?

    update_markdown_references
    delete_duplicates
    show_summary
  end

  private

  def find_duplicates
    puts "=== Finding duplicates in attachments ==="

    files = Dir.glob(File.join(@attachments_dir, '*')).select { |f| File.file?(f) }
    puts "Scanning #{files.length} files..."

    files.each do |path|
      filesize = File.size(path)
      next if filesize < MIN_SIZE_KB * 1024

      if @filesizes.key?(filesize)
        # Potential duplicate - check hash
        compare_and_enqueue(path, filesize)
      else
        @filesizes[filesize] = [path]
      end
    end

    puts "Found #{@duplicates.length} duplicate files"
    puts ""
  end

  def compare_and_enqueue(path, filesize)
    @digests[path] ||= Digest::SHA256.file(path).hexdigest

    @filesizes[filesize].each do |other_path|
      @digests[other_path] ||= Digest::SHA256.file(other_path).hexdigest

      next unless @digests[path] == @digests[other_path]

      # Found duplicate - keep the older one
      time1 = [File.mtime(path), File.ctime(path)].min
      time2 = [File.mtime(other_path), File.ctime(other_path)].min

      if time1 < time2
        @duplicates << [other_path, path] # other_path is newer, delete it
      else
        @duplicates << [path, other_path] # path is newer, delete it
      end
    end

    @filesizes[filesize] << path
  end

  def show_duplicates
    puts "=== Duplicates found ==="
    @duplicates.each do |delete_path, keep_path|
      delete_name = File.basename(delete_path)
      keep_name = File.basename(keep_path)
      size_mb = (File.size(delete_path) / 1024.0 / 1024.0).round(1)
      delete_time = File.mtime(delete_path).strftime('%Y-%m-%d')
      keep_time = File.mtime(keep_path).strftime('%Y-%m-%d')

      puts "  Will delete: #{delete_name} (#{delete_time}, #{size_mb} MB)"
      puts "  Keep master: #{keep_name} (#{keep_time})"
      puts ""
    end
  end

  def confirm_proceed?
    return true if @auto_confirm

    print "Delete #{@duplicates.length} duplicates and update references? [y/n] "
    response = $stdin.gets&.chomp&.downcase
    response == 'y'
  end

  def update_markdown_references
    puts ""
    puts "=== Updating markdown references ==="

    md_files = Dir.glob(File.join(@base_dir, '**', '*.md'))
    puts "Scanning #{md_files.length} markdown files..."

    @files_updated = 0
    @refs_updated = 0

    md_files.each do |md_file|
      content = File.read(md_file)
      original = content.dup

      @duplicates.each do |delete_path, keep_path|
        delete_name = File.basename(delete_path)
        keep_name = File.basename(keep_path)

        if content.include?(delete_name)
          content.gsub!(delete_name, keep_name)
          @refs_updated += 1
        end
      end

      if content != original
        File.write(md_file, content)
        relative = md_file.sub("#{@base_dir}/", '')
        puts "  ✓ Updated: #{relative}"
        @files_updated += 1
      end
    end

    puts "Updated #{@files_updated} files (#{@refs_updated} references)"
  end

  def delete_duplicates
    puts ""
    puts "=== Deleting duplicates ==="

    @deleted = 0
    @bytes_freed = 0

    @duplicates.each do |delete_path, _keep_path|
      if File.exist?(delete_path)
        size = File.size(delete_path)
        @bytes_freed += size

        # Use trash if available, otherwise delete
        if system('which trash > /dev/null 2>&1')
          system('trash', delete_path)
        else
          File.delete(delete_path)
        end

        puts "  ✗ Deleted: #{File.basename(delete_path)} (#{(size / 1024.0 / 1024.0).round(1)} MB)"
        @deleted += 1
      end
    end
  end

  def show_summary
    puts ""
    puts "=== Summary ==="
    puts "  Markdown files updated: #{@files_updated}"
    puts "  References updated: #{@refs_updated}"
    puts "  Duplicates deleted: #{@deleted}"
    puts "  Space freed: #{(@bytes_freed / 1024.0 / 1024.0).round(1)} MB"
  end
end

# Run
args = ARGV.reject { |a| a.start_with?('--') }
dir = args[0] || './notion'
auto_confirm = ARGV.include?('--yes')
NotionDuplicateFixer.new(dir, auto_confirm: auto_confirm).run
