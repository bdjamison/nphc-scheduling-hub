# Calendar observances

The public and approver calendar views now display 11 recurring U.S. federal holidays (including observed dates when fixed-date holidays fall on weekends) and the founding anniversaries of the nine NPHC organizations.

These are **frontend informational decorations only**. They are not reservations, do not write to Azure Tables, do not generate approval requests, and do not change availability checks. Existing calendar bookings remain unchanged.

Founding dates: Alpha Phi Alpha Dec 4, 1906; Alpha Kappa Alpha Jan 15, 1908; Kappa Alpha Psi Jan 5, 1911; Omega Psi Phi Nov 17, 1911; Delta Sigma Theta Jan 13, 1913; Phi Beta Sigma Jan 9, 1914; Zeta Phi Beta Jan 16, 1920; Sigma Gamma Rho Jul 12, 1922; Iota Phi Theta Sep 19, 1963.

The holiday logic follows the 11 regularly scheduled U.S. federal holidays and observed-day convention. Inauguration Day (applicable only to certain federal employees in the Washington, DC area every four years) and one-time presidential closure orders are not included.

For deployment, replace src/main.jsx and src/style.css with the files in this package. Test month/day/week views and availability before use.
