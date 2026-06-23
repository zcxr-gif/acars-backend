import SwiftUI

struct PlaneAnnotation: View {
    let heading: Double
    let isSelected: Bool
    let tint: Color
    var staff: Bool = false
    var vaMember: Bool = false

    var body: some View {
        ZStack {
            if isSelected {
                Circle()
                    .fill(tint.opacity(0.30))
                    .frame(width: 50, height: 50)
            }
            Image(systemName: "airplane")
                .resizable()
                .scaledToFit()
                .frame(width: 18, height: 18)
                .foregroundStyle(.white)
                .padding(6)
                .background(
                    Circle()
                        .fill(tint.gradient)
                        .shadow(color: tint.opacity(0.5), radius: isSelected ? 6 : 3)
                )
                .rotationEffect(.degrees(heading - 90))
                .overlay(alignment: .topTrailing) {
                    if staff {
                        Image(systemName: "star.fill")
                            .font(.system(size: 8))
                            .foregroundStyle(.yellow)
                            .padding(2)
                            .background(Circle().fill(.black.opacity(0.6)))
                            .offset(x: 4, y: -4)
                    } else if vaMember {
                        Circle()
                            .fill(.cyan)
                            .frame(width: 7, height: 7)
                            .overlay(Circle().stroke(.black.opacity(0.6), lineWidth: 1))
                            .offset(x: 4, y: -4)
                    }
                }
        }
        .accessibilityLabel("Aircraft heading \(Int(heading)) degrees")
    }
}
