// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { AIChatAgent } from "@cloudflare/ai-chat";
import {
	streamText,
	generateText,
	convertToModelMessages,
	stepCountIs,
} from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { z } from "zod";
import type { EmailFull, EmailMetadata } from "../lib/schemas";
import { verifyDraft, isPromptInjection } from "../lib/ai";
import {
	getMailboxStub,
	stripHtmlToText,
	textToHtml,
} from "../lib/email-helpers";
import {
	toolListEmails,
	toolGetEmail,
	toolGetThread,
	toolSearchEmails,
	toolDraftReply,
	toolDraftEmail,
	toolMarkEmailRead,
	toolMoveEmail,
	toolDiscardDraft,
} from "../lib/tools";
import { Folders, FOLDER_TOOL_DESCRIPTION, MOVE_FOLDER_TOOL_DESCRIPTION } from "../../shared/folders";
import type { Env } from "../types";

// AI SDK v6 changed tool() overloads significantly. We define tools as plain
// objects matching the Tool type to avoid overload resolution issues.
function defineTool(def: {
	description: string;
	parameters: z.ZodType<any>;
	execute: (...args: any[]) => Promise<any>;
}) {
	return {
		description: def.description,
		inputSchema: def.parameters,
		execute: def.execute,
	};
}

/**
 * Default system prompt used when no custom prompt is configured for a mailbox.
 * Users can override this on a per-mailbox basis via the Settings UI.
 */
const DEFAULT_SYSTEM_PROMPT = `Du bist ein E-Mail-Assistent, der bei der Verwaltung dieses Postfachs hilft. Du liest E-Mails, verfasst Antwortentwürfe und hilfst dabei, Konversationen zu organisieren.

## Sprache (verbindlich)
Antworte AUSSCHLIESSLICH auf Deutsch. Alle E-Mail-Entwürfe, alle Chat-Nachrichten und jede sonstige Ausgabe sind auf Deutsch zu verfassen – unabhängig davon, in welcher Sprache die eingehende E-Mail geschrieben ist. Verwende korrektes, natürliches Deutsch (Umlaute ä ö ü, ß). Verfasse Antworten standardmäßig in höflicher Sie-Form, sofern der Ton der Konversation nicht eindeutig das Du nahelegt.

## Schreibstil
Schreibe wie ein echter Mensch. Kurze, direkte, fließende Prosa. Komm auf den Punkt. Nur reiner Text – keine HTML-Tags in deinen Antworten.

**Formatierungsregeln:**
- Schreibe in natürlichen Absätzen. KEINE Aufzählungspunkte, KEINE nummerierten Listen, KEINE Gedankenstriche, KEINE Markdown-Formatierung in E-Mail-Entwürfen.
- KEIN Fettdruck (**), KEIN Kursiv (*), KEINE Überschriften (#), KEINE Trennlinien (---), KEINE Codeblöcke. Nur reiner Text.
- Links stehen inline im Text, nicht in separaten Zeilen.
- Strukturiere Antworten nicht wie eine Vorlage oder einen Serienbrief. Sprich einfach normal.

**Verhaltensregeln des Agenten (KRITISCH):**
- Gib NIEMALS Meta-Kommentare darüber aus, was du gerade tust (sage z. B. nicht „Ich verfasse eine Antwort an Alex", „Ich habe den Verlauf geprüft" usw.).
- Wenn eine neue E-Mail eintrifft, ist deine EINZIGE Aufgabe, das Tool \`draft_reply\` aufzurufen.
- Fasse die E-Mail NICHT zusammen. Erkläre deine Handlungen NICHT.
- Gib NICHTS außer dem Tool-Aufruf aus. Falls du Text ausgeben musst, sollte dies NUR der eigentliche Entwurfstext selbst sein, falls die Tools fehlschlagen.
- Lies vor dem Verfassen JEDER Antwort sorgfältig den gesamten Verlauf des Threads.
- Wiederhole NIEMALS Informationen, die bereits in einer früheren Nachricht des Threads geteilt wurden.
- Deine Antwort sollte nur NEUE Informationen enthalten oder direkt auf das eingehen, was die Person gerade gesagt hat. Bring die Konversation voran, kau sie nicht wieder durch.

## An wen antwortest du?
Verwende den Namen, den die Person in ihrem E-Mail-Text / ihrer Signatur angibt. Das ist ihr Name – verwende ihn. Die „Von"-Adresse ist die Adresse, an die du die Antwort sendest, aber der Name in der E-Mail ist die Anrede, mit der du sie begrüßt.

## KRITISCH: Nur Entwürfe – niemals senden
Du kannst NUR Entwürfe verfassen. Du hast NICHT die Fähigkeit, E-Mails direkt zu versenden.

- Verwende draft_reply, um Antworten auf bestehende E-Mails zu entwerfen
- Verwende draft_email, um neue ausgehende E-Mails zu entwerfen
- Die Bedienperson prüft die Entwürfe und versendet sie über die Oberfläche – du kannst sie nicht versenden

**KRITISCH: Der Entwurfstext darf AUSSCHLIESSLICH den E-Mail-Text enthalten.** Füge niemals Agenten-Kommentare, Statusmeldungen, Meta-Notizen, Markdown-Formatierung oder irgendetwas ein, das nicht Teil der eigentlichen E-Mail ist. Kein „Entwurf erstellt.", kein „---", kein „**fett**", kein „Hier ist der Entwurf:", keine Trennzeichen. Das Textfeld ist die wörtliche E-Mail, die der Empfänger liest. Alles andere gehört in deine Chat-Nachricht, nicht in den Entwurfstext.

**Füge den Entwurfsinhalt nicht in den Chat ein.** Die Entwürfe werden über die Tools gespeichert – die Bedienperson sieht sie im Ordner „Entwürfe". Sage in deiner Chat-Nachricht nur kurz, was du entworfen hast (z. B. „Antwort an Tim entworfen"). Wiederhole nicht den vollständigen E-Mail-Text im Chat.

## Verwaltung von Entwürfen
Verwende discard_draft, um Entwürfe zu löschen, die die Bedienperson ablehnt oder die nicht mehr benötigt werden.`;

/**
 * Fetch the custom system prompt for a mailbox from its R2 settings.
 * Falls back to DEFAULT_SYSTEM_PROMPT if none is configured.
 */
async function getSystemPrompt(env: Env, mailboxId: string): Promise<string> {
	try {
		const key = `mailboxes/${mailboxId}.json`;
		const obj = await env.BUCKET.get(key);
		if (obj) {
			const settings = await obj.json<Record<string, unknown>>();
			if (typeof settings.agentSystemPrompt === "string" && settings.agentSystemPrompt.trim()) {
				return settings.agentSystemPrompt;
			}
		}
	} catch {
		// Fall through to default
	}
	return DEFAULT_SYSTEM_PROMPT;
}

function createEmailTools(env: Env, mailboxId: string) {
	return {
		list_emails: defineTool({
			description:
				"List emails in a folder. Returns email metadata (id, subject, sender, recipient, date, read/starred status, thread_id). Use folder='inbox' for received emails, 'sent' for sent emails.",
			parameters: z.object({
				folder: z
					.string()
					.default(Folders.INBOX)
					.describe(FOLDER_TOOL_DESCRIPTION),
				limit: z
					.number()
					.default(20)
					.describe("Maximum number of emails to return"),
				page: z
					.number()
					.default(1)
					.describe("Page number for pagination"),
			}),
			execute: async ({ folder, limit, page }): Promise<unknown> => {
				return toolListEmails(env, mailboxId, { folder, limit, page });
			},
		}),

		get_email: defineTool({
			description:
				"Get a single email with its full body content and attachments. Use this to read the actual content of an email.",
			parameters: z.object({
				emailId: z.string().describe("The email ID to retrieve"),
			}),
			execute: async ({ emailId }): Promise<unknown> => {
				return toolGetEmail(env, mailboxId, emailId);
			},
		}),

		get_thread: defineTool({
			description:
				"Get all emails in a conversation thread. This is essential for understanding the full context of a conversation before drafting a response. Returns all messages sorted chronologically.",
			parameters: z.object({
				threadId: z
					.string()
					.describe(
						"The thread_id to retrieve all messages for. Get this from an email's thread_id field.",
					),
			}),
			execute: async ({ threadId }): Promise<unknown> => {
				return toolGetThread(env, mailboxId, threadId);
			},
		}),

		search_emails: defineTool({
			description:
				"Search for emails matching a query across subject and body fields.",
			parameters: z.object({
				query: z
					.string()
					.describe(
						"Search query to match against subject and body",
					),
				folder: z
					.string()
					.optional()
					.describe("Optional folder to restrict search to"),
			}),
			execute: async ({ query, folder }): Promise<unknown> => {
				return toolSearchEmails(env, mailboxId, { query, folder });
			},
		}),

		draft_email: defineTool({
			description:
				"Draft a new email (not a reply) and save it to the Drafts folder. This does NOT send — it saves a draft for the operator to review. Use this for composing new outbound emails. Write the body as plain text — no HTML tags.",
			parameters: z.object({
				to: z.string().email().describe("Recipient email address"),
				subject: z
					.string()
					.describe("Subject line"),
				body: z
					.string()
					.describe(
						"The plain text body of the email. No HTML — just write normally.",
					),
			}),
			execute: async ({ to, subject, body }): Promise<unknown> => {
				return toolDraftEmail(env, mailboxId, {
					to,
					subject,
					body,
					isPlainText: true,
				});
			},
		}),

		draft_reply: defineTool({
			description:
				"Draft a reply to an existing email and save it to the Drafts folder. This does NOT send — it saves a draft for the operator to review and send from the UI. Write the body as plain text — no HTML tags.",
			parameters: z.object({
				originalEmailId: z
					.string()
					.describe("The ID of the email being replied to"),
				to: z.string().email().describe("Recipient email address"),
				subject: z
					.string()
					.describe("Subject line (usually 'Re: ...')"),
				body: z
					.string()
					.describe(
						"The plain text body of the reply. No HTML — just write normally.",
					),
			}),
			execute: async ({ originalEmailId, to, subject, body }): Promise<unknown> => {
				return toolDraftReply(env, mailboxId, {
					originalEmailId,
					to,
					subject,
					body,
					isPlainText: true,
					runVerifyDraft: true,
				});
			},
		}),

		mark_email_read: defineTool({
			description: "Mark an email as read or unread.",
			parameters: z.object({
				emailId: z.string().describe("The email ID"),
				read: z
					.boolean()
					.describe("true to mark as read, false for unread"),
			}),
			execute: async ({ emailId, read }): Promise<unknown> => {
				return toolMarkEmailRead(env, mailboxId, emailId, read);
			},
		}),

		move_email: defineTool({
			description:
				"Move an email to a different folder (inbox, sent, draft, archive, trash).",
			parameters: z.object({
				emailId: z.string().describe("The email ID"),
				folderId: z
					.string()
					.describe(MOVE_FOLDER_TOOL_DESCRIPTION),
			}),
			execute: async ({ emailId, folderId }): Promise<unknown> => {
				return toolMoveEmail(env, mailboxId, emailId, folderId);
			},
		}),

		discard_draft: defineTool({
			description:
				"Delete a draft email. Use this to discard drafts that are no longer needed or were rejected by the operator.",
			parameters: z.object({
				draftId: z.string().describe("The ID of the draft to delete"),
			}),
			execute: async ({ draftId }): Promise<unknown> => {
				return toolDiscardDraft(env, mailboxId, draftId);
			},
		}),
	};
}

// Use `any` for the Env generic to avoid type conflicts between the custom
// SEND_EMAIL binding shape and the AIChatAgent constraint.  The actual env
// is fully typed inside the tools via the closure.
export class EmailAgent extends AIChatAgent<any> {
	async onChatMessage(onFinish: any) {
		const env = this.env as Env;
		const mailboxId = this.name;
		const workersai = createWorkersAI({ binding: env.AI });
		const tools = createEmailTools(env, mailboxId);
		const systemPrompt = await getSystemPrompt(env, mailboxId);

		const result = streamText({
			model: workersai("@cf/moonshotai/kimi-k2.5"),
			system: systemPrompt,
			messages: await convertToModelMessages(this.messages),
			tools,
			stopWhen: stepCountIs(5),
			onFinish,
		});

		return result.toUIMessageStreamResponse();
	}

	/**
	 * Handle HTTP requests to the agent DO. Intercepts /onNewEmail
	 * before passing to the default AIChatAgent handler.
	 */
	async onRequest(request: Request): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === "/onNewEmail" && request.method === "POST") {
			try {
				const emailData = await request.json() as {
					mailboxId: string;
					emailId: string;
					sender: string;
					subject: string;
					threadId: string;
				};
				const result = await this.handleNewEmail(emailData);
				return new Response(JSON.stringify(result), {
					headers: { "Content-Type": "application/json" },
				});
			} catch (e) {
				console.error("onNewEmail handler failed:", (e as Error).message);
				return new Response(
					JSON.stringify({ error: (e as Error).message }),
					{ status: 500, headers: { "Content-Type": "application/json" } },
				);
			}
		}
		return super.onRequest(request);
	}

	/**
	 * Called when a new email arrives. Reads it, loads the thread,
	 * drafts a response, and saves it to the Drafts folder.
	 */
	async handleNewEmail(emailData: {
		mailboxId: string;
		emailId: string;
		sender: string;
		subject: string;
		threadId: string;
	}) {
		const env = this.env as Env;
		const workersai = createWorkersAI({ binding: env.AI });
		const tools = createEmailTools(env, emailData.mailboxId);
		const systemPrompt = await getSystemPrompt(env, emailData.mailboxId);

		// Pre-read the email and thread so the agent has full context
		// without needing to waste tool calls discovering it
		const stub = getMailboxStub(env, emailData.mailboxId);

		let emailBody = "";
		let threadContext = "";
		try {
			const email = (await stub.getEmail(emailData.emailId)) as EmailFull | null;
			if (email?.body) {
				const isInjection = await isPromptInjection(env.AI, email.body);
				if (isInjection) {
					console.warn("Skipping auto-draft due to detected prompt injection:", emailData.emailId);
					
					// Log to agent chat so the user knows why it skipped
					const newMessages = [
						{
							id: crypto.randomUUID(),
							role: "user" as const,
							content: `[Automatisch ausgelöst] Neue E-Mail von ${emailData.sender}: "${emailData.subject}"`,
							createdAt: new Date(),
							parts: [{ type: "text" as const, text: `[Automatisch ausgelöst] Neue E-Mail von ${emailData.sender}: "${emailData.subject}"` }],
						},
						{
							id: crypto.randomUUID(),
							role: "assistant" as const,
							content: "⚠️ Automatische Entwurfserstellung blockiert: Die E-Mail scheint eine Prompt-Injection oder schädliche Anweisungen zu enthalten.",
							createdAt: new Date(),
							parts: [{ type: "text" as const, text: "⚠️ Automatische Entwurfserstellung blockiert: Die E-Mail scheint eine Prompt-Injection oder schädliche Anweisungen zu enthalten." }],
						},
					];
					await this.persistMessages([...this.messages, ...newMessages]);
					
					return;
				}
				
				emailBody = stripHtmlToText(email.body);
			}

		// Load thread for conversation context
		const threadEmails = (await stub.getEmails({ thread_id: emailData.threadId })) as EmailMetadata[];
		if (threadEmails.length > 1) {
			const fullThread = await Promise.all(
				threadEmails.map(async (e) => {
					const full = (await stub.getEmail(e.id)) as EmailFull | null;
					const text = full?.body ? stripHtmlToText(full.body) : "";
					return { id: e.id, sender: e.sender, recipient: e.recipient, subject: e.subject, date: e.date, folder_id: e.folder_id, body_text: text };
				}),
			);
			fullThread.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
			threadContext = fullThread
				.map((e) => `[${e.date}] ${e.sender} → ${e.recipient} (${e.folder_id}): ${e.body_text.substring(0, 500)}`)
				.join("\n\n");

			// Scan thread context for prompt injection too -- an attacker
			// could plant an injection in an earlier email in the thread
			// that gets included in the agent's prompt.
			if (threadContext) {
				const threadInjection = await isPromptInjection(env.AI, threadContext);
				if (threadInjection) {
					console.warn("Skipping auto-draft due to prompt injection in thread context:", emailData.threadId);
					const newMessages = [
						{
							id: crypto.randomUUID(),
							role: "user" as const,
							content: `[Automatisch ausgelöst] Neue E-Mail von ${emailData.sender}: "${emailData.subject}"`,
							createdAt: new Date(),
							parts: [{ type: "text" as const, text: `[Automatisch ausgelöst] Neue E-Mail von ${emailData.sender}: "${emailData.subject}"` }],
						},
						{
							id: crypto.randomUUID(),
							role: "assistant" as const,
							content: "Automatische Entwurfserstellung blockiert: Der Thread-Verlauf scheint eine Prompt-Injection oder schädliche Anweisungen zu enthalten.",
							createdAt: new Date(),
							parts: [{ type: "text" as const, text: "Automatische Entwurfserstellung blockiert: Der Thread-Verlauf scheint eine Prompt-Injection oder schädliche Anweisungen zu enthalten." }],
						},
					];
					await this.persistMessages([...this.messages, ...newMessages]);
					return;
				}
			}
		}
		} catch (e) {
			console.warn("Pre-read failed, agent will use tools:", (e as Error).message);
		}

		let autoPrompt = `Soeben ist eine neue E-Mail eingetroffen. Verfasse mit draft_reply eine passende Antwort auf Deutsch.

E-Mail-Details:
- Postfach: ${emailData.mailboxId}
- E-Mail-ID: ${emailData.emailId}
- Von: ${emailData.sender}
- Betreff: ${emailData.subject}
- Thread-ID: ${emailData.threadId}

E-Mail-Text:
${emailBody || "(konnte nicht vorab gelesen werden — verwende get_email, um sie zu lesen)"}`;

		if (threadContext) {
			autoPrompt += `

Vollständiger Thread-Verlauf (${emailData.threadId}):
${threadContext}`;
		} else {
			autoPrompt += `

Dies ist die erste Nachricht im Thread (keine vorherige Konversation).`;
		}

		autoPrompt += `

Verfasse auf Basis des E-Mail-Inhalts und des Thread-Kontexts oben mit draft_reply eine Antwort auf Deutsch. Falls du mehr Kontext benötigst, verwende get_thread mit der Thread-ID "${emailData.threadId}".`;

		// Fresh context for auto-draft -- don't include prior chat history
		// to avoid confusing the model with old messages and tool calls
		const messages = [
			{
				role: "user" as const,
				content: autoPrompt,
				parts: [{ type: "text" as const, text: autoPrompt }],
				createdAt: new Date(),
			},
		];

		try {
			const result = await generateText({
				model: workersai("@cf/moonshotai/kimi-k2.5"),
				system: systemPrompt,
				messages: await convertToModelMessages(messages),
				tools,
				stopWhen: stepCountIs(5),
			});

			// Check if draft_reply was called (saves to Drafts as side effect).
			// If NOT, save the agent's text response as a draft directly.
			const draftToolCalled = result.steps.some((step) =>
				step.toolCalls.some((tc) => tc.toolName === "draft_reply" || tc.toolName === "draft_email"),
			);

			if (!draftToolCalled && result.text.trim()) {
				// Model generated a draft inline as text -- verify with AI
				const sanitizedText = await verifyDraft(env.AI, result.text.trim());
				if (!sanitizedText) {
					// Inline text was entirely agent commentary, skip
				} else {
					const draftId = crypto.randomUUID();
					const draftStub = getMailboxStub(env, emailData.mailboxId);
					const reSubject = emailData.subject.startsWith("Re:")
						? emailData.subject
						: `Re: ${emailData.subject}`;
					await draftStub.createEmail(
						Folders.DRAFT,
						{
							id: draftId,
							subject: reSubject,
							sender: emailData.mailboxId.toLowerCase(),
							recipient: emailData.sender.toLowerCase(),
							date: new Date().toISOString(),
						// verifyDraft may return plain text or HTML depending on its
						// code path. Only wrap in textToHtml if it's plain text.
						body: /<[a-z][\s\S]*>/i.test(sanitizedText)
							? sanitizedText
							: textToHtml(sanitizedText),
						in_reply_to: emailData.emailId,
							email_references: null,
							thread_id: emailData.threadId,
						},
						[],
					);
					// Inline text saved as draft
				}
			}

			// Persist the conversation into the agent's chat history
			// If it called the tool, we just log a simple success message so the chat isn't cluttered
			// with conversational slop.
			const assistantText = draftToolCalled
				? `Antwortentwurf an ${emailData.sender} erstellt.`
				: result.text;

			const newMessages = [
				{
					id: crypto.randomUUID(),
					role: "user" as const,
					content: `[Automatisch ausgelöst] Neue E-Mail von ${emailData.sender}: "${emailData.subject}"`,
					createdAt: new Date(),
					parts: [
						{
							type: "text" as const,
							text: `[Automatisch ausgelöst] Neue E-Mail von ${emailData.sender}: "${emailData.subject}"`,
						},
					],
				},
				{
					id: crypto.randomUUID(),
					role: "assistant" as const,
					content: assistantText,
					createdAt: new Date(),
					parts: [
						{
							type: "text" as const,
							text: assistantText,
						},
					],
				},
			];

			await this.persistMessages([...this.messages, ...newMessages]);

			return { status: "draft_generated", text: result.text };
		} catch (e) {
			console.error("Auto-draft failed:", (e as Error).message);
			return { status: "error", error: (e as Error).message };
		}
	}
}
