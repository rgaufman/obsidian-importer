#!/usr/bin/env node
/**
 * Notion CLI Importer
 * Standalone script to export Notion workspace to markdown files
 *
 * Usage: node notion-cli.mjs [--token <token>] [--correction-date <YYYY-MM-DD>]
 *
 * Or set NOTION_TOKEN environment variable
 */

import { Client } from '@notionhq/client';
import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import * as http from 'http';
import { execSync } from 'child_process';

// Configuration
const OUTPUT_DIR = './notion';
const ATTACHMENTS_DIR = './notion/attachments';
const ERRORS_LOG = './notion/errors.log';

// Parse command line arguments
const args = process.argv.slice(2);
let NOTION_TOKEN = process.env.NOTION_TOKEN || '';
let CORRUPTION_DATE = null;

let RETRY_MODE = false;

for (let i = 0; i < args.length; i++) {
	if (args[i] === '--token' && args[i + 1]) {
		NOTION_TOKEN = args[i + 1];
		i++;
	} else if (args[i] === '--correction-date' && args[i + 1]) {
		CORRUPTION_DATE = new Date(args[i + 1]);
		i++;
	} else if (args[i] === '--retry') {
		RETRY_MODE = true;
	}
}

if (!NOTION_TOKEN) {
	console.error('Error: Notion API token required.');
	console.error('Usage: node notion-cli.mjs --token <token> [--correction-date <YYYY-MM-DD>] [--retry]');
	console.error('  --retry: Re-process only pages with failed blocks from previous run');
	console.error('Or set NOTION_TOKEN environment variable');
	process.exit(1);
}

// Initialize Notion client
const notion = new Client({ auth: NOTION_TOKEN });

// Statistics
const stats = {
	pages: 0,
	databases: 0,
	attachments: 0,
	errors: 0
};

// Track processed items to avoid duplicates
const processedIds = new Set();

// Errors buffer
const errors = [];

function logError(context, error) {
	const msg = `[${new Date().toISOString()}] ${context}: ${error.message || error}`;
	errors.push(msg);
	console.error(`  ❌ ${context}: ${error.message || error}`);
	stats.errors++;
}

function sanitizeFileName(name) {
	return name
		.replace(/[\\/:*?"<>|]/g, '-')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, 200);
}

function convertNotionDateToObsidian(dateString) {
	if (!dateString) return null;
	if (/^\d{4}-\d{2}-\d{2}$/.test(dateString)) return dateString;
	try {
		const date = new Date(dateString);
		const year = date.getFullYear();
		const month = String(date.getMonth() + 1).padStart(2, '0');
		const day = String(date.getDate()).padStart(2, '0');
		const hours = String(date.getHours()).padStart(2, '0');
		const minutes = String(date.getMinutes()).padStart(2, '0');
		const seconds = String(date.getSeconds()).padStart(2, '0');
		return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}`;
	} catch (e) {
		return dateString;
	}
}

// Find real content edit time from block timestamps
async function findRealContentEditTime(blocks, corruptionDate) {
	let newestValidTimeMs = 0;
	let newestValidTimeStr = '';

	async function scanBlocks(blocksToScan) {
		for (const block of blocksToScan) {
			if (block.last_edited_time) {
				const blockTime = new Date(block.last_edited_time);
				const blockTimeMs = blockTime.getTime();
				if (blockTime < corruptionDate && blockTimeMs > newestValidTimeMs) {
					newestValidTimeMs = blockTimeMs;
					newestValidTimeStr = block.last_edited_time;
				}
			}
			if (block.has_children && block.type !== 'child_page' && block.type !== 'child_database') {
				try {
					const children = await fetchAllBlocks(block.id);
					await scanBlocks(children);
				} catch (e) {
					// Continue on error
				}
			}
		}
	}

	await scanBlocks(blocks);
	return newestValidTimeStr || null;
}

// Fetch all blocks with pagination and retry logic
async function fetchAllBlocks(blockId, maxRetries = 3) {
	const blocks = [];
	let cursor = undefined;

	do {
		let response;
		let lastError;

		for (let attempt = 1; attempt <= maxRetries; attempt++) {
			try {
				response = await notion.blocks.children.list({
					block_id: blockId,
					start_cursor: cursor,
					page_size: 100
				});
				break; // Success, exit retry loop
			} catch (e) {
				lastError = e;
				if (attempt < maxRetries) {
					const delay = 1000 * attempt;
					console.log(`    ⚠️  Retry ${attempt}/${maxRetries} for block ${blockId} (waiting ${delay}ms)`);
					await new Promise(r => setTimeout(r, delay));
				}
			}
		}

		if (!response) {
			throw lastError; // All retries failed
		}

		blocks.push(...response.results.filter(b => 'type' in b));
		cursor = response.has_more ? response.next_cursor : undefined;
	} while (cursor);

	return blocks;
}

// Extract rich text to plain text
function richTextToPlain(richText) {
	if (!richText || !Array.isArray(richText)) return '';
	return richText.map(t => t.plain_text || '').join('');
}

// Extract rich text to markdown
function richTextToMarkdown(richText) {
	if (!richText || !Array.isArray(richText)) return '';
	return richText.map(t => {
		let text = t.plain_text || '';
		if (t.annotations) {
			if (t.annotations.code) text = `\`${text}\``;
			if (t.annotations.bold) text = `**${text}**`;
			if (t.annotations.italic) text = `*${text}*`;
			if (t.annotations.strikethrough) text = `~~${text}~~`;
		}
		if (t.href) text = `[${text}](${t.href})`;
		return text;
	}).join('');
}

// Set file timestamps (created and modified)
// On macOS, uses SetFile to set creation time and touch for modification time
function setFileTimestamps(filePath, createdTime, modifiedTime) {
	try {
		// Set modification time using fs.utimesSync
		const mtime = modifiedTime ? new Date(modifiedTime) : new Date();
		fs.utimesSync(filePath, mtime, mtime);

		// Set creation time (birthtime) on macOS using SetFile command
		// Format: "MM/DD/YYYY HH:MM:SS"
		if (createdTime) {
			const created = new Date(createdTime);
			const month = String(created.getMonth() + 1).padStart(2, '0');
			const day = String(created.getDate()).padStart(2, '0');
			const year = created.getFullYear();
			const hours = String(created.getHours()).padStart(2, '0');
			const minutes = String(created.getMinutes()).padStart(2, '0');
			const seconds = String(created.getSeconds()).padStart(2, '0');
			const dateStr = `${month}/${day}/${year} ${hours}:${minutes}:${seconds}`;

			try {
				// SetFile -d sets the creation date on macOS
				execSync(`SetFile -d "${dateStr}" "${filePath}"`, { stdio: 'ignore' });
			} catch (e) {
				// SetFile might not be available, try touch as fallback for mtime only
			}
		}
	} catch (e) {
		// Ignore timestamp errors
	}
}

// Download a file
async function downloadFile(url, filename, timestamps = null) {
	return new Promise((resolve, reject) => {
		const filePath = path.join(ATTACHMENTS_DIR, filename);

		// Check if already exists
		if (fs.existsSync(filePath)) {
			resolve(filePath);
			return;
		}

		const protocol = url.startsWith('https') ? https : http;
		const file = fs.createWriteStream(filePath);

		protocol.get(url, (response) => {
			if (response.statusCode === 301 || response.statusCode === 302) {
				// Follow redirect
				downloadFile(response.headers.location, filename, timestamps).then(resolve).catch(reject);
				file.close();
				fs.unlinkSync(filePath);
				return;
			}
			response.pipe(file);
			file.on('finish', () => {
				file.close();
				// Set timestamps if provided
				if (timestamps) {
					setFileTimestamps(filePath, timestamps.created, timestamps.modified);
				}
				stats.attachments++;
				resolve(filePath);
			});
		}).on('error', (err) => {
			file.close();
			if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
			reject(err);
		});
	});
}

// Generate unique filename for attachment
function getAttachmentFilename(url, baseName) {
	const urlPath = new URL(url).pathname;
	const ext = path.extname(urlPath) || '.bin';
	const safeName = sanitizeFileName(baseName || 'attachment');
	let filename = `${safeName}${ext}`;
	let counter = 1;
	while (fs.existsSync(path.join(ATTACHMENTS_DIR, filename))) {
		filename = `${safeName}-${counter}${ext}`;
		counter++;
	}
	return filename;
}

// Convert blocks to markdown
// pageTimestamps: { created: string, modified: string } for setting attachment file times
async function blocksToMarkdown(blocks, indent = '', pageTimestamps = null) {
	const lines = [];

	for (const block of blocks) {
		try {
			let line = '';
			const type = block.type;
			const data = block[type];

			switch (type) {
				case 'paragraph':
					line = richTextToMarkdown(data?.rich_text);
					break;

				case 'heading_1':
					line = `# ${richTextToMarkdown(data?.rich_text)}`;
					break;

				case 'heading_2':
					line = `## ${richTextToMarkdown(data?.rich_text)}`;
					break;

				case 'heading_3':
					line = `### ${richTextToMarkdown(data?.rich_text)}`;
					break;

				case 'bulleted_list_item':
					line = `${indent}- ${richTextToMarkdown(data?.rich_text)}`;
					break;

				case 'numbered_list_item':
					line = `${indent}1. ${richTextToMarkdown(data?.rich_text)}`;
					break;

				case 'to_do':
					const checked = data?.checked ? 'x' : ' ';
					line = `${indent}- [${checked}] ${richTextToMarkdown(data?.rich_text)}`;
					break;

				case 'toggle':
					line = `${indent}<details><summary>${richTextToMarkdown(data?.rich_text)}</summary>\n`;
					break;

				case 'quote':
					line = `> ${richTextToMarkdown(data?.rich_text)}`;
					break;

				case 'callout':
					const emoji = data?.icon?.emoji || '💡';
					line = `> ${emoji} ${richTextToMarkdown(data?.rich_text)}`;
					break;

				case 'code':
					const lang = data?.language || '';
					const code = richTextToPlain(data?.rich_text);
					line = `\`\`\`${lang}\n${code}\n\`\`\``;
					break;

				case 'divider':
					line = '---';
					break;

				case 'image':
					try {
						const imgUrl = data?.file?.url || data?.external?.url;
						if (imgUrl) {
							const caption = richTextToPlain(data?.caption) || 'image';
							const filename = getAttachmentFilename(imgUrl, caption);
							await downloadFile(imgUrl, filename, pageTimestamps);
							line = `![${caption}](attachments/${filename})`;
						}
					} catch (e) {
						logError(`Download image in block ${block.id}`, e);
						line = `![image](${data?.file?.url || data?.external?.url || ''})`;
					}
					break;

				case 'file':
				case 'pdf':
					try {
						const fileUrl = data?.file?.url || data?.external?.url;
						if (fileUrl) {
							const fileName = data?.name || richTextToPlain(data?.caption) || 'file';
							const filename = getAttachmentFilename(fileUrl, fileName);
							await downloadFile(fileUrl, filename, pageTimestamps);
							line = `[${fileName}](attachments/${filename})`;
						}
					} catch (e) {
						logError(`Download file in block ${block.id}`, e);
					}
					break;

				case 'video':
					const videoUrl = data?.file?.url || data?.external?.url;
					if (videoUrl) {
						line = `[Video](${videoUrl})`;
					}
					break;

				case 'embed':
				case 'bookmark':
					const embedUrl = data?.url;
					if (embedUrl) {
						line = `[${embedUrl}](${embedUrl})`;
					}
					break;

				case 'table':
					// Tables need special handling
					if (block.has_children) {
						const rows = await fetchAllBlocks(block.id);
						const tableLines = [];
						for (let i = 0; i < rows.length; i++) {
							const row = rows[i];
							if (row.type === 'table_row') {
								const cells = row.table_row.cells.map(cell => richTextToMarkdown(cell));
								tableLines.push(`| ${cells.join(' | ')} |`);
								if (i === 0) {
									tableLines.push(`| ${cells.map(() => '---').join(' | ')} |`);
								}
							}
						}
						line = tableLines.join('\n');
					}
					break;

				case 'child_page':
					line = `📄 [[${data?.title || 'Untitled'}]]`;
					break;

				case 'child_database':
					line = `🗃️ [[${data?.title || 'Untitled Database'}]]`;
					break;

				case 'column_list':
				case 'column':
					// Process children
					break;

				case 'synced_block':
					// Process children
					break;

				case 'link_preview':
					line = `[${data?.url}](${data?.url})`;
					break;

				case 'equation':
					line = `$$${data?.expression}$$`;
					break;

				default:
					// Unknown block type
					break;
			}

			if (line) lines.push(line);

			// Process children (except for child_page and child_database)
			if (block.has_children && type !== 'child_page' && type !== 'child_database' && type !== 'table') {
				const children = await fetchAllBlocks(block.id);
				const childIndent = (type === 'bulleted_list_item' || type === 'numbered_list_item' || type === 'to_do')
					? indent + '  ' : indent;
				const childContent = await blocksToMarkdown(children, childIndent, pageTimestamps);
				if (childContent) lines.push(childContent);
				if (type === 'toggle') lines.push('</details>');
			}

		} catch (e) {
			logError(`Process block ${block.id} (${block.type})`, e);
		}
	}

	return lines.join('\n\n');
}

// Extract user info
async function getUserName(userId) {
	try {
		const user = await notion.users.retrieve({ user_id: userId });
		return user.name || user.person?.email || userId;
	} catch (e) {
		return userId;
	}
}

// Build frontmatter
async function buildFrontmatter(page, contentUpdated) {
	const fm = {};

	fm['notion-id'] = page.id;

	if (page.created_time) {
		fm.created = convertNotionDateToObsidian(page.created_time);
	}
	if (page.last_edited_time) {
		fm.updated = convertNotionDateToObsidian(page.last_edited_time);
	}
	if (contentUpdated) {
		fm.content_updated = convertNotionDateToObsidian(contentUpdated);
	}
	if (page.created_by?.id) {
		fm.created_by = await getUserName(page.created_by.id);
	}
	if (page.last_edited_by?.id) {
		fm.updated_by = await getUserName(page.last_edited_by.id);
	}
	if (page.url) {
		fm.source = page.url;
	}

	// Extract page properties
	if (page.properties) {
		for (const [key, prop] of Object.entries(page.properties)) {
			if (prop.type === 'title') continue; // Skip title

			try {
				let value = null;
				switch (prop.type) {
					case 'rich_text':
						value = richTextToPlain(prop.rich_text);
						break;
					case 'number':
						value = prop.number;
						break;
					case 'select':
						value = prop.select?.name;
						break;
					case 'multi_select':
						value = prop.multi_select?.map(s => s.name);
						break;
					case 'date':
						value = prop.date?.start;
						break;
					case 'checkbox':
						value = prop.checkbox;
						break;
					case 'url':
						value = prop.url;
						break;
					case 'email':
						value = prop.email;
						break;
					case 'phone_number':
						value = prop.phone_number;
						break;
					case 'status':
						value = prop.status?.name;
						break;
					case 'people':
						value = prop.people?.map(p => p.name || p.id);
						break;
					// Skip formula, rollup, relation for simplicity
				}
				if (value !== null && value !== undefined && value !== '') {
					fm[key] = value;
				}
			} catch (e) {
				// Skip property on error
			}
		}
	}

	// Convert to YAML
	const lines = ['---'];
	for (const [key, value] of Object.entries(fm)) {
		if (Array.isArray(value)) {
			lines.push(`${key}:`);
			for (const item of value) {
				lines.push(`  - ${JSON.stringify(item)}`);
			}
		} else if (typeof value === 'string' && (value.includes(':') || value.includes('#') || value.includes('\n'))) {
			lines.push(`${key}: ${JSON.stringify(value)}`);
		} else {
			lines.push(`${key}: ${value}`);
		}
	}
	lines.push('---');
	return lines.join('\n');
}

// Extract page title
function getPageTitle(page) {
	if (page.properties) {
		for (const prop of Object.values(page.properties)) {
			if (prop.type === 'title' && prop.title?.length > 0) {
				return richTextToPlain(prop.title);
			}
		}
	}
	return 'Untitled';
}

// Import a single page
async function importPage(pageId, parentPath = '') {
	if (processedIds.has(pageId)) return;
	processedIds.add(pageId);

	try {
		const page = await notion.pages.retrieve({ page_id: pageId });
		const title = getPageTitle(page);
		const safeName = sanitizeFileName(title);

		console.log(`  📄 ${title}`);

		// Fetch blocks
		const blocks = await fetchAllBlocks(pageId);

		// Check for child pages/databases
		const hasChildren = blocks.some(b => b.type === 'child_page' || b.type === 'child_database');

		// Determine paths
		let folderPath = parentPath;
		let filePath;

		if (hasChildren) {
			folderPath = path.join(parentPath, safeName);
			fs.mkdirSync(path.join(OUTPUT_DIR, folderPath), { recursive: true });
			filePath = path.join(folderPath, `${safeName}.md`);
		} else {
			filePath = path.join(parentPath, `${safeName}.md`);
		}

		// Calculate content_updated if needed
		let contentUpdated = null;
		if (CORRUPTION_DATE && page.last_edited_time) {
			const pageEditTime = new Date(page.last_edited_time);
			if (pageEditTime >= CORRUPTION_DATE) {
				contentUpdated = await findRealContentEditTime(blocks, CORRUPTION_DATE);
			}
		}

		// Create timestamps object for file times
		// Use contentUpdated (recovered real edit time) if available, otherwise use page timestamp
		const pageTimestamps = {
			created: page.created_time,
			modified: contentUpdated || page.last_edited_time
		};

		// Build frontmatter
		const frontmatter = await buildFrontmatter(page, contentUpdated);

		// Convert blocks to markdown (pass timestamps for attachments)
		const content = await blocksToMarkdown(blocks, '', pageTimestamps);

		// Write file
		const fullPath = path.join(OUTPUT_DIR, filePath);
		fs.mkdirSync(path.dirname(fullPath), { recursive: true });
		fs.writeFileSync(fullPath, `${frontmatter}\n\n${content}`);

		// Set file timestamps to match Notion dates
		setFileTimestamps(fullPath, pageTimestamps.created, pageTimestamps.modified);
		stats.pages++;

		// Process child pages and databases
		for (const block of blocks) {
			if (block.type === 'child_page') {
				await importPage(block.id, folderPath);
			} else if (block.type === 'child_database') {
				await importDatabase(block.id, folderPath);
			}
		}

	} catch (e) {
		logError(`Import page ${pageId}`, e);
	}
}

// Import a database
async function importDatabase(databaseId, parentPath = '') {
	if (processedIds.has(databaseId)) return;
	processedIds.add(databaseId);

	try {
		const database = await notion.databases.retrieve({ database_id: databaseId });

		// Check if this is a linked database (no data sources) - skip those
		if (!database.properties || Object.keys(database.properties).length === 0) {
			console.log(`  ⏭️  Skipping linked/empty database ${databaseId}`);
			return;
		}

		const title = richTextToPlain(database.title) || 'Untitled Database';
		const safeName = sanitizeFileName(title);

		console.log(`  🗃️  ${title}`);

		// Create database folder
		const dbFolder = path.join(parentPath, safeName);
		fs.mkdirSync(path.join(OUTPUT_DIR, dbFolder), { recursive: true });

		// Create database info file
		const dbInfo = {
			'notion-id': database.id,
			title: title,
			url: database.url,
			properties: Object.keys(database.properties || {})
		};

		// Set timestamps for database file
		const dbTimestamps = {
			created: database.created_time,
			modified: database.last_edited_time
		};

		const dbFilePath = path.join(OUTPUT_DIR, dbFolder, `_${safeName}.base.md`);
		fs.writeFileSync(
			dbFilePath,
			`---\n${Object.entries(dbInfo).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join('\n')}\n---\n\nThis is a Notion database.`
		);
		setFileTimestamps(dbFilePath, dbTimestamps.created, dbTimestamps.modified);
		stats.databases++;

		// Query all pages in database
		let cursor = undefined;
		do {
			const response = await notion.databases.query({
				database_id: databaseId,
				start_cursor: cursor,
				page_size: 100
			});

			for (const page of response.results) {
				if ('properties' in page) {
					await importPage(page.id, dbFolder);
				}
			}

			cursor = response.has_more ? response.next_cursor : undefined;
		} while (cursor);

	} catch (e) {
		logError(`Import database ${databaseId}`, e);
	}
}

// Find the parent page ID for a block
async function findParentPageId(blockId) {
	try {
		const block = await notion.blocks.retrieve({ block_id: blockId });
		if (block.parent?.type === 'page_id') {
			return block.parent.page_id;
		} else if (block.parent?.type === 'block_id') {
			// Recursively find parent
			return findParentPageId(block.parent.block_id);
		} else if (block.parent?.type === 'database_id') {
			return block.parent.database_id;
		}
		return null;
	} catch (e) {
		console.log(`    Could not find parent for block ${blockId}: ${e.message}`);
		return null;
	}
}

// Parse errors.log to get failed block IDs
function parseErrorsLog() {
	if (!fs.existsSync(ERRORS_LOG)) {
		return [];
	}
	const content = fs.readFileSync(ERRORS_LOG, 'utf-8');
	const blockIds = [];
	const blockRegex = /Process block ([a-f0-9-]+)/g;
	let match;
	while ((match = blockRegex.exec(content)) !== null) {
		blockIds.push(match[1]);
	}
	return blockIds;
}

// Retry mode: re-import only pages with failed blocks
async function retryFailedBlocks() {
	console.log('🔄 Retry mode: Re-importing pages with failed blocks...\n');

	const failedBlockIds = parseErrorsLog();
	if (failedBlockIds.length === 0) {
		console.log('No failed blocks found in errors.log');
		return;
	}

	console.log(`Found ${failedBlockIds.length} failed blocks, finding parent pages...\n`);

	// Find unique parent pages
	const pageIds = new Set();
	for (const blockId of failedBlockIds) {
		const pageId = await findParentPageId(blockId);
		if (pageId) {
			pageIds.add(pageId);
		}
	}

	if (pageIds.size === 0) {
		console.log('Could not find parent pages for any failed blocks');
		return;
	}

	console.log(`Re-importing ${pageIds.size} pages...\n`);

	// Clear the processed set so we can re-import
	processedIds.clear();

	// Re-import each page
	for (const pageId of pageIds) {
		await importPage(pageId);
	}

	// Write updated errors log
	if (errors.length > 0) {
		fs.writeFileSync(ERRORS_LOG, errors.join('\n'));
	} else {
		// Remove errors log if no errors remain
		if (fs.existsSync(ERRORS_LOG)) {
			fs.unlinkSync(ERRORS_LOG);
		}
	}

	console.log('\n' + '='.repeat(50));
	console.log('✅ Retry completed!\n');
	console.log(`   📄 Pages re-imported: ${stats.pages}`);
	console.log(`   📎 Attachments: ${stats.attachments}`);
	console.log(`   ❌ Remaining errors: ${stats.errors}`);
	if (stats.errors > 0) {
		console.log(`   Error log: ${path.resolve(ERRORS_LOG)}`);
	}
	console.log('');
}

// Main import function
async function importAll() {
	console.log('🚀 Starting Notion export...\n');

	if (CORRUPTION_DATE) {
		console.log(`⏰ Timestamp correction enabled for dates after: ${CORRUPTION_DATE.toISOString().slice(0, 10)}\n`);
	}

	// Create output directories
	fs.mkdirSync(OUTPUT_DIR, { recursive: true });
	fs.mkdirSync(ATTACHMENTS_DIR, { recursive: true });

	// Search for all accessible content
	console.log('📚 Discovering pages and databases...\n');

	let cursor = undefined;
	const rootItems = [];

	do {
		const response = await notion.search({
			start_cursor: cursor,
			page_size: 100
		});

		for (const item of response.results) {
			// Only process root-level items (workspace parent or no parent we can access)
			if (item.parent?.type === 'workspace') {
				rootItems.push(item);
			}
		}

		cursor = response.has_more ? response.next_cursor : undefined;
	} while (cursor);

	console.log(`Found ${rootItems.length} root items\n`);

	// Process all root items
	for (const item of rootItems) {
		if (item.object === 'page') {
			await importPage(item.id);
		} else if (item.object === 'database') {
			await importDatabase(item.id);
		}
	}

	// Now process any remaining items that weren't reached through hierarchy
	cursor = undefined;
	do {
		const response = await notion.search({
			start_cursor: cursor,
			page_size: 100
		});

		for (const item of response.results) {
			if (!processedIds.has(item.id)) {
				if (item.object === 'page') {
					await importPage(item.id);
				} else if (item.object === 'database') {
					await importDatabase(item.id);
				}
			}
		}

		cursor = response.has_more ? response.next_cursor : undefined;
	} while (cursor);

	// Write errors log
	if (errors.length > 0) {
		fs.writeFileSync(ERRORS_LOG, errors.join('\n'));
	}

	// Print summary
	console.log('\n' + '='.repeat(50));
	console.log('✅ Export completed!\n');
	console.log(`   📄 Pages: ${stats.pages}`);
	console.log(`   🗃️  Databases: ${stats.databases}`);
	console.log(`   📎 Attachments: ${stats.attachments}`);
	console.log(`   ❌ Errors: ${stats.errors}`);
	console.log(`\n   Output: ${path.resolve(OUTPUT_DIR)}`);
	if (stats.errors > 0) {
		console.log(`   Error log: ${path.resolve(ERRORS_LOG)}`);
	}
	console.log('');
}

// Run
const main = RETRY_MODE ? retryFailedBlocks : importAll;
main().catch(e => {
	console.error('Fatal error:', e);
	process.exit(1);
});
