import ws from 'ws';
import { Client, GatewayIntentBits, Events } from 'discord.js';
import { createClient } from '@supabase/supabase-js';
import 'dotenv/config';

globalThis.WebSocket = ws;

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY);

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ],
});

// Regex para detetar convites de outros servidores Discord
const INVITE_REGEX = /(discord\.gg|discord(?:app)?\.com\/invite)\/[a-zA-Z0-9-]+/i;

// IDs de canais isentos (ex: canal de staff onde podem partilhar links)
const EXEMPT_CHANNEL_IDS = (process.env.EXEMPT_CHANNEL_IDS || '').split(',').filter(Boolean);

// Cargos isentos (ex: staff pode partilhar links)
const EXEMPT_ROLE_IDS = (process.env.EXEMPT_ROLE_IDS || '').split(',').filter(Boolean);

client.once(Events.ClientReady, () => {
  console.log(`✅ Bot online como ${client.user.tag}`);
});

client.on(Events.MessageCreate, async (message) => {
  // Ignora bots e DMs
  if (message.author.bot || !message.guild) return;

  // Ignora canais isentos
  if (EXEMPT_CHANNEL_IDS.includes(message.channel.id)) return;

  // Ignora membros com cargo isento
  const memberRoles = message.member?.roles.cache.map(r => r.id) || [];
  if (memberRoles.some(r => EXEMPT_ROLE_IDS.includes(r))) return;

  // Verifica se a mensagem contém um convite de Discord
  if (INVITE_REGEX.test(message.content)) {
    try {
      // Verifica se é um convite para o PRÓPRIO servidor (permitido)
      const inviteMatch = message.content.match(/(?:discord\.gg|discord(?:app)?\.com\/invite)\/([a-zA-Z0-9-]+)/i);
      if (inviteMatch) {
        try {
          const invite = await client.fetchInvite(inviteMatch[1]);
          if (invite.guild?.id === message.guild.id) {
            return; // convite para o próprio servidor, permitido
          }
        } catch {
          // convite inválido/expirado - trata como spam de qualquer forma
        }
      }

      // Apaga a mensagem
      await message.delete().catch(() => {});

      // Regista o flag
      await supabase.from('automod_flags').insert({
        discord_id: message.author.id,
        channel_id: message.channel.id,
        message_content: message.content,
        flag_reason: 'discord_invite_link',
        action_taken: 'deleted',
      });

      // Conta avisos ativos
      const { count: activeWarnings } = await supabase
        .from('warnings')
        .select('*', { count: 'exact', head: true })
        .eq('discord_id', message.author.id)
        .eq('active', true);

      // Regista aviso automático
      const { data: log } = await supabase.from('mod_logs').insert({
        target_discord_id: message.author.id,
        target_username: message.author.username,
        moderator_discord_id: null,
        action: 'warn',
        reason: 'Partilha de link de convite de outro servidor Discord (automático)',
        source: 'automod',
      }).select().single();

      await supabase.from('warnings').insert({
        discord_id: message.author.id,
        reason: 'Link de convite de outro servidor (deteção automática)',
        issued_by: 'automod',
        mod_log_id: log?.id,
        active: true,
      });

      const newWarningCount = (activeWarnings || 0) + 1;

      // Envia aviso ao utilizador no canal
      const warningMsg = await message.channel.send({
        content: `⚠️ ${message.author}, não é permitido partilhar links de convite de outros servidores. (Aviso ${newWarningCount})`,
      });
      setTimeout(() => warningMsg.delete().catch(() => {}), 8000);

      // Se atingir 3 avisos, aplica timeout automático
      if (newWarningCount >= 3) {
        const member = await message.guild.members.fetch(message.author.id).catch(() => null);
        if (member) {
          const timeoutMs = 60 * 60 * 1000; // 1 hora
          await member.timeout(timeoutMs, 'Excesso de avisos automáticos (links de spam)').catch(() => {});

          await supabase.from('mod_logs').insert({
            target_discord_id: message.author.id,
            target_username: message.author.username,
            moderator_discord_id: null,
            action: 'timeout',
            reason: 'Timeout automático por excesso de avisos (3+) de spam de links',
            source: 'automod',
            duration_minutes: 60,
            expires_at: new Date(Date.now() + timeoutMs).toISOString(),
          });

          await message.channel.send({
            content: `🔇 ${message.author} foi castigado automaticamente (1h) por excesso de avisos.`,
          });
        }
      }
    } catch (err) {
      console.error('Erro no automod:', err);
    }
  }
});

client.login(process.env.DISCORD_BOT_TOKEN);

const WELCOME_CHANNEL_ID = process.env.WELCOME_CHANNEL_ID;

client.on(Events.GuildMemberAdd, async (member) => {
  if (!WELCOME_CHANNEL_ID) return;

  const channel = member.guild.channels.cache.get(WELCOME_CHANNEL_ID);
  if (!channel) return;

  try {
    await channel.send({
      content: `${member}`, // menção fora do embed para notificar a pessoa
      embeds: [{
        title: `🎉 Bem-vindo(a) ao ${member.guild.name}!`,
        description:
          `Olá ${member.user.username}, que bom ter-te aqui!\n\n` +
          `📜 Lê as regras em <#942098381982040084>\n` +
          `💬 Apresenta-te em <#932666031867056258>\n` +
          `🎮 Diverte-te e participa na comunidade!`,
        color: 0xD65A7E, // cor da marca Club Party
        thumbnail: { url: member.user.displayAvatarURL() },
        footer: { text: `Agora somos ${member.guild.memberCount} membros!` },
      }],
    });
  } catch (err) {
    console.error('Erro ao enviar mensagem de boas-vindas:', err);
  }
});