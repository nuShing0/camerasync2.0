import 'api_client.dart';

/// A group the user belongs to — the subset of the server's `publicGroup`
/// shape (apps/server/src/routes/groups.js) the mobile app needs.
class Group {
  const Group({
    required this.id,
    required this.name,
    this.primaryColor,
    this.joinedAt,
    this.owner,
    this.role,
    this.inviteCode,
    this.inviteUrl,
  });

  final String id;
  final String name;

  /// The team color as `#rrggbb`, when the server sent one.
  final String? primaryColor;

  /// When the current user joined, for picking a default primary group.
  final DateTime? joinedAt;

  /// The owner's user id, and the current user's role in the group
  /// ('admin', 'member' or 'viewer'; the owner also has 'admin').
  final int? owner;
  final String? role;

  /// The group's invite: a six-character code (shown as ABC-DEF) and the
  /// link members share, which opens the web app's join page. Admins can
  /// reset it, and then the old code and link stop working.
  final String? inviteCode;
  final String? inviteUrl;

  /// Admins and the owner can change the team color and manage members.
  bool canManage(int? userId) =>
      role == 'admin' || (owner != null && owner == userId);

  factory Group.fromJson(Map<String, dynamic> json) => Group(
        id: json['id'].toString(),
        name: (json['name'] ?? '').toString(),
        primaryColor: json['primaryColor'] as String?,
        joinedAt: DateTime.tryParse('${json['joinedAt'] ?? ''}'),
        owner: (json['owner'] as num?)?.toInt(),
        role: json['role'] as String?,
        inviteCode: json['inviteCode'] as String?,
        inviteUrl: json['inviteUrl'] as String?,
      );
}

/// What an invite shows before joining (GET /api/groups/invites/:code).
class GroupInvite {
  const GroupInvite({
    required this.id,
    required this.name,
    required this.memberCount,
    required this.isMember,
    this.primaryColor,
  });

  final String id;
  final String name;
  final int memberCount;

  /// The user is in the group already.
  final bool isMember;
  final String? primaryColor;

  factory GroupInvite.fromJson(Map<String, dynamic> json) => GroupInvite(
        id: json['id'].toString(),
        name: (json['name'] ?? '').toString(),
        memberCount: (json['memberCount'] as num?)?.toInt() ?? 0,
        isMember: json['isMember'] == true,
        primaryColor: json['primaryColor'] as String?,
      );
}

/// Someone who asked to join a group by its ID, waiting for an admin.
class JoinRequest {
  const JoinRequest({
    required this.userId,
    required this.name,
    required this.email,
    required this.requestedAt,
  });

  final int userId;
  final String name;
  final String email;
  final DateTime requestedAt;

  factory JoinRequest.fromJson(Map<String, dynamic> json) => JoinRequest(
        userId: (json['userId'] as num).toInt(),
        name: (json['name'] ?? '').toString(),
        email: (json['email'] ?? '').toString(),
        requestedAt:
            DateTime.tryParse('${json['requestedAt'] ?? ''}')?.toLocal() ??
                DateTime.now(),
      );
}

/// One person on a group's roster.
class GroupMember {
  const GroupMember({required this.id, required this.name, required this.role});

  final int id;
  final String name;

  /// 'admin', 'member' or 'viewer'.
  final String role;

  factory GroupMember.fromJson(Map<String, dynamic> json) => GroupMember(
        id: (json['id'] as num).toInt(),
        name: (json['name'] ?? 'Unnamed member').toString(),
        role: (json['role'] ?? 'member').toString(),
      );
}

/// REST calls for groups, mirroring apps/web/src/api/groups.js.
class GroupsApi {
  const GroupsApi(this._api);

  final ApiClient _api;

  /// Every group the current user belongs to.
  Future<List<Group>> getMyGroups() async {
    final data = await _api.get('/api/groups');
    final groups = (data as Map)['groups'] as List;
    return groups
        .map((g) => Group.fromJson(Map<String, dynamic>.from(g)))
        .toList();
  }

  /// Create a group; the server makes the creator its owner and admin, and
  /// gives it an invite. [id] must be letters and numbers only (checked
  /// server-side too, see POST /api/groups).
  Future<Group> createGroup({
    required String id,
    required String name,
    String primaryColor = '#ead217',
  }) async {
    final data = await _api.post('/api/groups', {
      'id': id,
      'name': name,
      'primaryColor': primaryColor,
    });
    return Group.fromJson(
      Map<String, dynamic>.from((data as Map)['group'] as Map),
    );
  }

  /// The group an invite [code] belongs to, before joining. The server
  /// takes any case, with or without the dash; it answers 404 for a code no
  /// group has, and 429 after too many wrong ones.
  Future<GroupInvite> getInvite(String code) async {
    final data =
        await _api.get('/api/groups/invites/${Uri.encodeComponent(code)}');
    return GroupInvite.fromJson(
        Map<String, dynamic>.from((data as Map)['group'] as Map));
  }

  /// Join with an invite [code]. Joining a group you're in just returns it.
  Future<Group> joinWithInvite(String code) async {
    final data = await _api
        .post('/api/groups/invites/${Uri.encodeComponent(code)}/join');
    return Group.fromJson(
        Map<String, dynamic>.from((data as Map)['group'] as Map));
  }

  /// A new invite code and link (admins and the owner); the old ones stop
  /// working. Returns the group with them.
  Future<Group> resetInvite(String groupId) async {
    final data = await _api
        .post('/api/groups/${Uri.encodeComponent(groupId)}/invite/reset');
    return Group.fromJson(
        Map<String, dynamic>.from((data as Map)['group'] as Map));
  }

  /// Ask to join the group with this exact ID, for an admin to approve.
  /// [alreadyMember] is true when the user is in it already.
  Future<({bool alreadyMember, String groupId, String groupName})>
      requestToJoin(String groupId) async {
    final data =
        await _api.post('/api/groups/requests', {'groupId': groupId}) as Map;
    final group = data['group'] as Map;
    return (
      alreadyMember: data['status'] == 'member',
      groupId: group['id'].toString(),
      groupName: (group['name'] ?? '').toString(),
    );
  }

  /// The group's waiting requests to join, oldest first (admins only).
  Future<List<JoinRequest>> getRequests(String groupId) async {
    final data =
        await _api.get('/api/groups/${Uri.encodeComponent(groupId)}/requests');
    final requests = ((data as Map)['requests'] as List?) ?? const [];
    return requests
        .map((r) => JoinRequest.fromJson(Map<String, dynamic>.from(r)))
        .toList();
  }

  /// Let someone who asked into the group (admins only).
  Future<void> approveRequest(String groupId, int userId) async {
    await _api.post(
        '/api/groups/${Uri.encodeComponent(groupId)}/requests/$userId/approve');
  }

  /// Turn down a request to join (admins only).
  Future<void> declineRequest(String groupId, int userId) async {
    await _api.delete(
        '/api/groups/${Uri.encodeComponent(groupId)}/requests/$userId');
  }

  /// A group's roster, owner first. Members only.
  Future<List<GroupMember>> getMembers(String groupId) async {
    final data =
        await _api.get('/api/groups/${Uri.encodeComponent(groupId)}/members');
    final members = ((data as Map)['members'] as List?) ?? const [];
    return members
        .map((m) => GroupMember.fromJson(Map<String, dynamic>.from(m)))
        .toList();
  }

  /// Move a member up or down the viewer < member < admin ladder. The server
  /// checks the caller outranks them.
  Future<void> changeMemberRole(
      String groupId, int memberId, String role) async {
    await _api.patch(
      '/api/groups/${Uri.encodeComponent(groupId)}/members/$memberId',
      {'role': role},
    );
  }

  Future<void> removeMember(String groupId, int memberId) async {
    await _api.delete(
        '/api/groups/${Uri.encodeComponent(groupId)}/members/$memberId');
  }

  /// Change the team color (admins and the owner only). Returns the group.
  Future<Group> updateColor(String groupId, String primaryColor) async {
    final data = await _api.patch(
      '/api/groups/${Uri.encodeComponent(groupId)}',
      {'primaryColor': primaryColor},
    );
    return Group.fromJson(
        Map<String, dynamic>.from((data as Map)['group'] as Map));
  }

  /// Rename the group (owner only).
  Future<Group> updateDetails(String groupId, {required String name}) async {
    final data = await _api.patch(
        '/api/groups/${Uri.encodeComponent(groupId)}', {'name': name});
    return Group.fromJson(
        Map<String, dynamic>.from((data as Map)['group'] as Map));
  }

  /// Leave a group. The owner has to hand it to someone else first.
  Future<void> leave(String groupId) async {
    await _api.post('/api/groups/${Uri.encodeComponent(groupId)}/leave');
  }

  /// Make another member the owner; the old owner stays on as an admin.
  Future<Group> transfer(String groupId, int userId) async {
    final data = await _api.post(
      '/api/groups/${Uri.encodeComponent(groupId)}/transfer',
      {'userId': userId},
    );
    return Group.fromJson(
        Map<String, dynamic>.from((data as Map)['group'] as Map));
  }

  /// Delete the group with all its sessions and recordings (owner only).
  Future<void> deleteGroup(String groupId) async {
    await _api.delete('/api/groups/${Uri.encodeComponent(groupId)}');
  }
}
