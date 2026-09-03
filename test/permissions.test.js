'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { useTempDatabase, makeGuild, makeMember, makeRole } = require('./helpers');

useTempDatabase('permissions');
const { initDatabase } = require('../src/database/database');
initDatabase();

const rolesRepository = require('../src/database/roles');
const permissions = require('../src/utils/permissions');
const roleService = require('../src/services/roleService');
const { PERMISSION_LEVELS } = require('../src/config');

function setup() {
  const guild = makeGuild();
  const adminRole = makeRole(guild, { name: 'Admin', position: 40 });
  const modRole = makeRole(guild, { name: 'Moderator', position: 30 });
  const admin = makeMember(guild, { username: 'admin', roles: [adminRole] });
  const mod = makeMember(guild, { username: 'mod', roles: [modRole] });
  const member = makeMember(guild, { username: 'member' });
  return { guild, adminRole, modRole, admin, mod, member, owner: guild.owner };
}

test('owner always has full access, even with nothing configured', () => {
  const { guild, owner, admin, member } = setup();
  assert.equal(permissions.isOwner(owner), true);
  assert.equal(permissions.isAdmin(owner), true);
  assert.equal(permissions.isModerator(owner), true);
  assert.equal(permissions.getPermissionLevel(owner), PERMISSION_LEVELS.owner.key);

  // Nothing configured → owner-only bootstrap: the "admin" member is just a member.
  assert.equal(permissions.roleState(guild, 'ADMIN').state, 'unset');
  assert.equal(permissions.isAdmin(admin), false);
  assert.equal(permissions.isAdmin(member), false);
  assert.match(permissions.describeAdminDenial(guild), /server owner/);
});

test('configured admin role grants admin; moderators get moderator only', () => {
  const { guild, adminRole, modRole, admin, mod, member } = setup();
  rolesRepository.setRole(guild.id, 'ADMIN', adminRole.id, 'test');
  rolesRepository.setRole(guild.id, 'MODERATOR', modRole.id, 'test');

  assert.equal(permissions.roleState(guild, 'ADMIN').state, 'ok');
  assert.equal(permissions.isAdmin(admin), true);
  assert.equal(permissions.isModerator(admin), true);
  assert.equal(permissions.isAdmin(mod), false);
  assert.equal(permissions.isModerator(mod), true);
  assert.equal(permissions.isModerator(member), false);
  assert.equal(permissions.getPermissionLevel(mod), 'moderator');

  const adminCommand = { permission: 'admin' };
  const modCommand = { permission: 'moderator' };
  const openCommand = { permission: 'everyone' };
  assert.equal(permissions.canUseCommand(mod, adminCommand), false);
  assert.equal(permissions.canUseCommand(mod, modCommand), true);
  assert.equal(permissions.canUseCommand(member, modCommand), false);
  assert.equal(permissions.canUseCommand(member, openCommand), true);
  assert.equal(permissions.canUseCommand(admin, adminCommand), true);
});

test('deleted or unassigned admin role falls back to owner-only', () => {
  const { guild, adminRole, admin, owner } = setup();
  rolesRepository.setRole(guild.id, 'ADMIN', adminRole.id, 'test');
  assert.equal(permissions.isAdmin(admin), true);

  // Nobody holds the role any more → unassigned → owner only.
  adminRole.members.clear();
  admin.roles.cache.clear();
  assert.equal(permissions.roleState(guild, 'ADMIN').state, 'unassigned');
  assert.equal(permissions.isAdmin(admin), false);
  assert.equal(permissions.isAdmin(owner), true);
  assert.match(permissions.describeAdminDenial(guild), /Nobody holds/);

  // Role deleted → missing → owner only, with a clear explanation.
  guild.roles.cache.delete(adminRole.id);
  assert.equal(permissions.roleState(guild, 'ADMIN').state, 'missing');
  assert.equal(permissions.isAdmin(owner), true);
  assert.match(permissions.describeAdminDenial(guild), /no longer exists/);
});

test('replacing a deleted role with setrole immediately takes effect', () => {
  const { guild, adminRole, admin } = setup();
  rolesRepository.setRole(guild.id, 'ADMIN', adminRole.id, 'test');
  guild.roles.cache.delete(adminRole.id);
  assert.equal(permissions.isAdmin(admin), false);

  const newAdminRole = makeRole(guild, { name: 'New Admin', position: 45 });
  const previous = roleService.setRoleMapping(guild, 'ADMIN', newAdminRole, guild.ownerId);
  assert.equal(previous, adminRole.id);

  admin.roles.cache.set(newAdminRole.id, newAdminRole);
  newAdminRole.members.set(admin.id, admin);
  assert.equal(permissions.isAdmin(admin), true);
  assert.equal(rolesRepository.getRoleId(guild.id, 'ADMIN'), newAdminRole.id);
});

test('hierarchy: moderators cannot target admins, nobody targets the owner or the bot', () => {
  const { guild, adminRole, modRole, admin, mod, member, owner } = setup();
  rolesRepository.setRole(guild.id, 'ADMIN', adminRole.id, 'test');
  rolesRepository.setRole(guild.id, 'MODERATOR', modRole.id, 'test');

  assert.equal(roleService.canActorTarget(mod, admin).ok, false);
  assert.equal(roleService.canActorTarget(admin, owner).ok, false);
  assert.equal(roleService.canActorTarget(admin, guild.members.me).ok, false);
  assert.equal(roleService.canActorTarget(mod, mod).ok, false);
  assert.equal(roleService.canActorTarget(mod, member).ok, true);
  assert.equal(roleService.canActorTarget(admin, mod).ok, true);
  assert.equal(roleService.canActorTarget(owner, admin).ok, true);

  // Bot role hierarchy: a role above the bot cannot be managed.
  const tooHigh = makeRole(guild, { name: 'Above Bot', position: 99 });
  assert.equal(roleService.botCanManageRole(guild, tooHigh).ok, false);
  assert.equal(roleService.botCanManageRole(guild, modRole).ok, true);
  const untouchable = makeMember(guild, { username: 'high', roles: [tooHigh] });
  assert.equal(roleService.botCanManageMember(untouchable).ok, false);
  assert.equal(roleService.botCanManageMember(member).ok, true);
});

test('join roles: Member + Survival assigned from the database, deleted roles skipped', async () => {
  const { guild } = setup();
  const memberRole = makeRole(guild, { name: 'Member', position: 5 });
  const survivalRole = makeRole(guild, { name: 'Survival', position: 6 });
  rolesRepository.setRole(guild.id, 'MEMBER', memberRole.id, 'test');
  rolesRepository.setRole(guild.id, 'SURVIVAL', survivalRole.id, 'test');

  const newcomer = makeMember(guild, { username: 'new' });
  const first = await roleService.assignJoinRoles(newcomer);
  assert.deepEqual(first.assigned, ['MEMBER', 'SURVIVAL']);
  assert.equal(newcomer.roles.cache.has(memberRole.id), true);
  assert.equal(newcomer.roles.cache.has(survivalRole.id), true);

  // Survival role deleted and replaced → the replacement is used, nothing crashes.
  guild.roles.cache.delete(survivalRole.id);
  const another = makeMember(guild, { username: 'another' });
  const second = await roleService.assignJoinRoles(another);
  assert.deepEqual(second.assigned, ['MEMBER']);
  assert.equal(second.skipped.length, 1);

  const replacement = makeRole(guild, { name: 'Survival v2', position: 6 });
  roleService.setRoleMapping(guild, 'SURVIVAL', replacement, guild.ownerId);
  const third = await roleService.assignJoinRoles(makeMember(guild, { username: 'third' }));
  assert.deepEqual(third.assigned, ['MEMBER', 'SURVIVAL']);
});

test('isStaff for suggestions accepts moderators and extra staff roles, never Manage Server alone', () => {
  const { guild, modRole, mod, member } = setup();
  rolesRepository.setRole(guild.id, 'MODERATOR', modRole.id, 'test');
  assert.equal(permissions.isStaff(mod), true);
  assert.equal(permissions.isStaff(member), false);

  const helper = makeRole(guild, { name: 'Helper', position: 3 });
  const helperMember = makeMember(guild, { username: 'helper', roles: [helper] });
  assert.equal(permissions.isStaff(helperMember, { staffRoleIds: [helper.id] }), true);
  assert.equal(permissions.isStaff(member, { staffRoleIds: [helper.id] }), false);
});
