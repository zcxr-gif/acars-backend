import SwiftUI

struct UserStatsView: View {
    let userId: String
    let username: String?

    @State private var stats: UserStats?
    @State private var errorMessage: String?
    @State private var isLoading: Bool = false

    var body: some View {
        List {
            if isLoading {
                ProgressView().frame(maxWidth: .infinity).listRowSeparator(.hidden)
            }
            if let err = errorMessage {
                Section { Text(err).foregroundStyle(.red).font(.caption) }
            }
            if let stats {
                Section("Identity") {
                    LabeledContent("Pilot", value: username ?? userId)
                    if let discourse = stats.discourseUsername {
                        LabeledContent("Forum", value: discourse)
                    }
                    if let va = stats.virtualOrganization {
                        LabeledContent("VA", value: va)
                    }
                    if let roles = stats.roles, !roles.isEmpty {
                        LabeledContent("Roles", value: roles.joined(separator: ", "))
                    }
                }

                Section("Grade") {
                    if let grade = stats.calculatedGrade {
                        LabeledContent("Grade", value: "Grade \(grade)")
                    }
                    if let xp = stats.totalXP {
                        LabeledContent("XP", value: format(xp))
                    }
                    if let rank = stats.atcRankLabel {
                        LabeledContent("ATC Rank", value: rank)
                    }
                    if let ops = stats.atcOperations {
                        LabeledContent("ATC operations", value: "\(ops)")
                    }
                }

                Section("Activity") {
                    if let time = stats.flightTimeFormatted {
                        LabeledContent("Total flight time", value: time)
                    }
                    if let landings = stats.landingCount {
                        LabeledContent("Landings", value: "\(landings)")
                    }
                    if let online = stats.onlineFlights {
                        LabeledContent("Online flights", value: "\(online)")
                    }
                }

                if let v = stats.violations, v > 0 {
                    Section("Violations") {
                        LabeledContent("Total", value: "\(v)")
                        if let recent = stats.total12MonthsViolations {
                            LabeledContent("Last 12 months", value: "\(recent)")
                        }
                        if let counts = stats.violationCountByLevel {
                            ForEach(counts.sorted(by: { $0.key < $1.key }), id: \.key) { k, v in
                                LabeledContent("Level \(k)", value: "\(v)")
                            }
                        }
                    }
                }
            }
        }
        .navigationTitle(username ?? "Pilot")
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
        .refreshable { await load() }
    }

    private func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            stats = try await APIClient.shared.fetchUserStats(userId: userId)
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func format(_ value: Double) -> String {
        let f = NumberFormatter()
        f.numberStyle = .decimal
        f.maximumFractionDigits = 0
        return f.string(from: NSNumber(value: value)) ?? "\(Int(value))"
    }
}
