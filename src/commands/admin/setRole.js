'use strict';

const { ROLE_TYPES, getRoleType } = require('../../config');
const roleService = require('../../services/roleService');

const TYPE_CHOICES = Object.values(ROLE_TYPES).map((type) => ({
  name: type.label,
  value: type.key,
}));

module.exports = {
  name: 'setrole',
  category: 'admin',
  description: 'Map a Discord role to a logical bot role (Admin, Moderator, Member, Survival, Mute).',
  permission: 'admin',
  args: [
    { name: 'role', type: 'role', description: 'The Discord role to use.', required: true },
    { name: 'as', type: 'literal', value: 'as' },
    {
      name: 'type',
      type: 'string',
      description: 'Which logical role this Discord role should fill.',
      required: true,
      choices: TYPE_CHOICES,
    },
  ],
  examples: ['setrole @Admin as Admin', 'setrole @Muted as Mute'],
  async execute(ctx) {
    const role = ctx.get('role');
    const type = getRoleType(ctx.get('type'));
    if (!type) {
      return ctx.failure(
        `Unknown role type. Choose one of: ${TYPE_CHOICES.map((c) => `\`${c.name}\``).join(', ')}.`,
      );
    }

    if (role.id === ctx.guild.roles.everyone.id) {
      return ctx.failure('The @everyone role cannot be used as a logical role.');
    }
    if (role.managed) {
      return ctx.failure(`${role} is managed by an integration and cannot be used.`);
    }

    const warnings = [];
    const hierarchy = roleService.botCanManageRole(ctx.guild, role);
    if (!hierarchy.ok && type.key !== ROLE_TYPES.ADMIN.key && type.key !== ROLE_TYPES.MODERATOR.key) {
      warnings.push(
        `⚠️ ${hierarchy.reason} I can *recognise* it, but I will not be able to assign or remove it until that is fixed.`,
      );
    }
    if (type.key === ROLE_TYPES.ADMIN.key && role.members.size === 0) {
      warnings.push(
        '⚠️ Nobody holds this role yet. Until someone does, only the **server owner** can run Admin commands.',
      );
    }

    const previous = roleService.setRoleMapping(ctx.guild, type.key, role, ctx.user.id);
    const previousText = previous && previous !== role.id ? ` (previously <@&${previous}>)` : '';

    return ctx.success(
      `${type.emoji} **${type.label}** role is now ${role}${previousText}.\n${type.description}` +
        (warnings.length ? `\n\n${warnings.join('\n')}` : ''),
      { allowedMentions: { parse: [] } },
    );
  },
};
