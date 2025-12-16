const fs = require('fs');
const path = require('path');

/**
 * 修复KV格式文件 - 找到正确的闭合位置，丢弃之后的垃圾内容
 * @param {string} content - 文件内容
 * @returns {string} - 修复后的内容
 */
function fixKvFormat(content) {
	let depth = 0;
	let lastValidPosition = 0;
	let inString = false;
	let inComment = false;
	let hasFoundFirstOpen = false;

	for (let i = 0; i < content.length; i++) {
		const char = content[i];
		const prevChar = i > 0 ? content[i - 1] : '';
		const nextChar = i < content.length - 1 ? content[i + 1] : '';

		// 处理注释
		if (!inString && char === '/' && nextChar === '/') {
			inComment = true;
			continue;
		}

		if (inComment && char === '\n') {
			inComment = false;
			continue;
		}

		if (inComment) {
			continue;
		}

		// 处理字符串
		if (char === '"' && prevChar !== '\\') {
			inString = !inString;
			continue;
		}

		if (inString) {
			continue;
		}

		// 统计花括号深度
		if (char === '{') {
			depth++;
			hasFoundFirstOpen = true;
		} else if (char === '}') {
			depth--;

			// 找到最外层闭合括号
			if (depth === 0 && hasFoundFirstOpen) {
				lastValidPosition = i + 1;
				// 第一次找到完整闭合就可以停止了
				break;
			}

			// 如果深度变成负数，说明格式已经错误
			if (depth < 0) {
				break;
			}
		}
	}

	// 如果找到了有效的闭合位置，截断后面的内容
	if (lastValidPosition > 0) {
		return content.substring(0, lastValidPosition).trimEnd() + '\n';
	}

	return content;
}

/**
 * 修复文件夹中所有的KV格式文件
 */
function fixKvFilesInFolder() {
	const folderPath = path.join(__dirname, 'resource', 'npc', 'heroes');

	if (!fs.existsSync(folderPath)) {
		console.error(`文件夹不存在: ${folderPath}`);
		return;
	}

	const files = fs.readdirSync(folderPath);
	const txtFiles = files.filter(file => file.endsWith('.txt'));

	console.log(`找到 ${txtFiles.length} 个 .txt 文件`);

	let fixedCount = 0;
	let errorCount = 0;

	for (const file of txtFiles) {
		const filePath = path.join(folderPath, file);

		try {
			console.log(`处理: ${file}`);

			// 读取原始内容
			const originalContent = fs.readFileSync(filePath, 'utf-8');

			// 修复格式
			const fixedContent = fixKvFormat(originalContent);

			// 只有内容发生变化时才写入
			if (fixedContent !== originalContent) {
				fs.writeFileSync(filePath, fixedContent, 'utf-8');
				console.log(`  ✓ 已修复 (删除了 ${originalContent.length - fixedContent.length} 个字符)`);
				fixedCount++;
			} else {
				console.log(`  - 无需修复`);
			}
		} catch (error) {
			console.error(`  ✗ 错误: ${error.message}`);
			errorCount++;
		}
	}

	console.log('\n=== 完成 ===');
	console.log(`总文件数: ${txtFiles.length}`);
	console.log(`已修复: ${fixedCount}`);
	console.log(`错误: ${errorCount}`);
	console.log(`无需修复: ${txtFiles.length - fixedCount - errorCount}`);
}

// 运行修复
fixKvFilesInFolder();
