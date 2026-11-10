// A small Markdown reader for model replies. It builds DOM nodes and sets text only through
// text nodes and textContent, so nothing a model writes can become markup or script.
// Links are http(s) only; anything else stays as the words that were written.

/** Split one line of text into inline parts: text, code, strong, em, link. */
export function parseInline(text) {
	const parts = [];
	const pattern = /`([^`\n]+)`|\*\*([^*\n]+)\*\*|\*([^*\s](?:[^*\n]*[^*\s])?)\*|\[([^\]\n]+)\]\(([^)\s]+)\)/g;
	let last = 0;
	for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
		if (match.index > last) parts.push({ type: "text", text: text.slice(last, match.index) });
		if (match[1] !== undefined) parts.push({ type: "code", text: match[1] });
		else if (match[2] !== undefined) parts.push({ type: "strong", text: match[2] });
		else if (match[3] !== undefined) parts.push({ type: "em", text: match[3] });
		else if (/^https?:\/\//i.test(match[5])) parts.push({ type: "link", text: match[4], href: match[5] });
		else parts.push({ type: "text", text: match[0] }); // not a web link: keep the words as written
		last = match.index + match[0].length;
	}
	if (last < text.length) parts.push({ type: "text", text: text.slice(last) });
	return parts;
}

function tableCells(line) {
	let body = line.trim();
	if (body.startsWith("|")) body = body.slice(1);
	if (/(^|[^\\])\|$/.test(body)) body = body.slice(0, -1);
	return body.split(/(?<!\\)\|/).map((cell) => cell.replace(/\\\|/g, "|").trim());
}

function tableAlign(line) {
	if (!line.includes("|")) return undefined;
	const cells = tableCells(line);
	if (!cells.every((cell) => /^:?-+:?$/.test(cell))) return undefined;
	return cells.map((cell) => (cell.startsWith(":") && cell.endsWith(":") ? "center" : cell.startsWith(":") ? "left" : cell.endsWith(":") ? "right" : null));
}

/** Split a reply into blocks: code, heading, list, table, paragraph. */
export function parseBlocks(source) {
	const blocks = [];
	const lines = source.replace(/\r\n?/g, "\n").split("\n");
	let paragraph = [];
	const flush = () => {
		if (paragraph.length > 0) blocks.push({ type: "paragraph", text: paragraph.join("\n") });
		paragraph = [];
	};
	const closeList = () => {
		const previous = blocks[blocks.length - 1];
		if (previous?.type === "list") previous.open = false;
	};
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index];
		const fence = /^\s*```(.*)$/.exec(line);
		if (fence) {
			flush();
			closeList();
			const code = [];
			index++;
			while (index < lines.length && !/^\s*```\s*$/.test(lines[index])) code.push(lines[index++]);
			blocks.push({ type: "code", text: code.join("\n"), language: fence[1].trim() });
			continue;
		}
		const heading = /^(#{1,6})\s+(.*)$/.exec(line);
		if (heading) {
			flush();
			closeList();
			blocks.push({ type: "heading", level: heading[1].length, text: heading[2] });
			continue;
		}
		const item = /^\s*(?:([-*•])|(\d+)[.)])\s+(.*)$/.exec(line);
		if (item) {
			flush();
			const ordered = item[2] !== undefined;
			const previous = blocks[blocks.length - 1];
			if (previous?.type === "list" && previous.ordered === ordered && previous.open) previous.items.push(item[3]);
			else blocks.push({ type: "list", ordered, items: [item[3]], open: true });
			continue;
		}
		if (line.includes("|") && index + 1 < lines.length) {
			const header = tableCells(line);
			const align = tableAlign(lines[index + 1]);
			if (align && align.length === header.length) {
				flush();
				closeList();
				const rows = [];
				index += 2;
				while (index < lines.length && lines[index].trim() !== "" && lines[index].includes("|")) {
					const cells = tableCells(lines[index++]).slice(0, header.length);
					while (cells.length < header.length) cells.push("");
					rows.push(cells);
				}
				index--;
				blocks.push({ type: "table", header, align, rows });
				continue;
			}
		}
		if (line.trim() === "") {
			flush();
			closeList();
			continue;
		}
		const previous = blocks[blocks.length - 1];
		if (previous?.type === "list" && previous.open && paragraph.length === 0 && /^\s{2,}\S/.test(line)) {
			previous.items[previous.items.length - 1] += ` ${line.trim()}`; // a wrapped list item
			continue;
		}
		closeList();
		paragraph.push(line);
	}
	flush();
	for (const block of blocks) delete block.open;
	return blocks;
}

function inlineInto(parent, text, document) {
	for (const part of parseInline(text)) {
		if (part.type === "text") parent.append(document.createTextNode(part.text));
		else if (part.type === "link") parent.append(Object.assign(document.createElement("a"), { textContent: part.text, href: part.href, target: "_blank", rel: "noopener noreferrer" }));
		else parent.append(Object.assign(document.createElement(part.type), { textContent: part.text }));
	}
}

/** Fill `parent` with the rendered reply. */
export function renderMarkdown(parent, source, document) {
	parent.replaceChildren();
	for (const block of parseBlocks(source)) {
		if (block.type === "code") {
			const pre = document.createElement("pre");
			pre.append(Object.assign(document.createElement("code"), { textContent: block.text }));
			parent.append(pre);
		} else if (block.type === "heading") {
			const heading = document.createElement(block.level <= 2 ? "h3" : "h4");
			inlineInto(heading, block.text, document);
			parent.append(heading);
		} else if (block.type === "list") {
			const list = document.createElement(block.ordered ? "ol" : "ul");
			for (const text of block.items) {
				const item = document.createElement("li");
				inlineInto(item, text, document);
				list.append(item);
			}
			parent.append(list);
		} else if (block.type === "table") {
			const table = document.createElement("table");
			const row = (cells, tag) => {
				const tr = document.createElement("tr");
				cells.forEach((text, column) => {
					const cell = document.createElement(tag);
					if (block.align[column]) cell.className = `align-${block.align[column]}`;
					inlineInto(cell, text, document);
					tr.append(cell);
				});
				return tr;
			};
			const head = document.createElement("thead");
			head.append(row(block.header, "th"));
			table.append(head);
			if (block.rows.length > 0) {
				const body = document.createElement("tbody");
				for (const cells of block.rows) body.append(row(cells, "td"));
				table.append(body);
			}
			const wrap = Object.assign(document.createElement("div"), { className: "table-wrap" }); // a wide table scrolls by itself
			wrap.append(table);
			parent.append(wrap);
		} else {
			const paragraph = document.createElement("p");
			block.text.split("\n").forEach((line, index) => {
				if (index > 0) paragraph.append(document.createElement("br"));
				inlineInto(paragraph, line, document);
			});
			parent.append(paragraph);
		}
	}
}
